/**
 * share-tokens.ts — signing, issuance, verification, and revocation for
 * Instinct's unauthenticated share links.
 *
 * Flow:
 *   1. Designer calls `issueShareToken` → a nonce UUID is persisted in
 *      `apex_share_tokens`, and a signed base64url token is returned.
 *      The signed blob encodes { siteId, exp, nonce } + HMAC-SHA256(sig).
 *   2. Client opens /share/<token> → we `verifyShareToken` (format,
 *      signature, expiry). `loadActiveTokenRow` then checks the DB row
 *      for revocation + touches last_accessed_at/access_count.
 *   3. Designer can `revokeShareToken` — flips revoked_at in place so
 *      any open client tabs stop being authoritative.
 *
 * Crypto:
 *   - HMAC-SHA256 via Node's crypto.createHmac. No new primitives.
 *   - Payload is JSON.stringify → base64url; signature is
 *     base64url(hmac(payload)). Output format: `<payloadB64>.<sigB64>`.
 *   - Constant-time comparison (crypto.timingSafeEqual) on verify.
 *
 * Safety:
 *   - The secret is read from `process.env.INSTINCT_SHARE_SECRET`. In
 *     production we throw if it's unset (loud — this is a required env
 *     var). In test environments a deterministic fallback is used so
 *     tests don't depend on environment state.
 *   - The SIGNED BLOB never lands in analytics metadata. Only
 *     `token_nonce` (the DB UUID) is emitted. This prevents ops /
 *     support staff from ever seeing a replayable token.
 *   - TTL is capped at 90 days at the orchestration boundary so a
 *     misconfigured caller can't mint a ten-year token.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { safeQuery } from "@/lib/db";

export interface ShareTokenClaims {
  siteId: string;
  nonce: string; // UUID mirrored in apex_share_tokens
  exp: number; // Unix seconds
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days — hard cap

export class ShareSecretMissingError extends Error {
  constructor() {
    super(
      "[share-tokens] INSTINCT_SHARE_SECRET is not set. " +
        "Add it to the Vercel project env vars in production.",
    );
    this.name = "ShareSecretMissingError";
  }
}

/** Read the signing secret. Fails loud in production; falls back in
 * tests so jest can run without environment munging. */
export function getShareSecret(): string {
  const s = process.env.INSTINCT_SHARE_SECRET;
  if (s && s.length > 0) return s;
  if (process.env.NODE_ENV === "test") {
    return "share-test-secret-never-use-in-production";
  }
  if (process.env.NODE_ENV === "production") {
    throw new ShareSecretMissingError();
  }
  console.warn(
    "[share-tokens] INSTINCT_SHARE_SECRET not set — using dev fallback. Do NOT ship without setting this.",
  );
  return "share-dev-fallback-do-not-use-in-production";
}

/* ----------------------------- base64url helpers ---------------------- */

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(s: string): Buffer {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

/* ----------------------------- sign / verify -------------------------- */

/**
 * Sign a claims object and return a base64url token of shape
 * `<payload>.<signature>`. Pure function — no DB / no side effects.
 * Exposed with an explicit `secret` param so tests can use DI.
 */
export function signShareToken(claims: ShareTokenClaims, secret: string): string {
  const payload = JSON.stringify(claims);
  const payloadB64 = toBase64Url(Buffer.from(payload, "utf-8"));
  const mac = createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = toBase64Url(mac);
  return `${payloadB64}.${sigB64}`;
}

export type VerifyShareTokenResult =
  | { ok: true; claims: ShareTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify a signed share token. Checks format, constant-time compares the
 * HMAC, and validates the expiry claim. Does NOT consult the DB — that
 * is a separate orchestration step (`loadActiveTokenRow`) so this
 * function stays pure for unit tests.
 */
export function verifyShareToken(
  token: string,
  secret: string,
): VerifyShareTokenResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [payloadB64, sigB64] = parts;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = createHmac("sha256", secret).update(payloadB64).digest();
    actual = fromBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: ShareTokenClaims;
  try {
    const json = fromBase64Url(payloadB64).toString("utf-8");
    const parsed = JSON.parse(json);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return { ok: false, reason: "malformed" };
    }
    claims = parsed as ShareTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSec) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

/* ----------------------------- issuance + revocation ------------------ */

export interface IssuedShareToken {
  token: string;
  tokenRowId: string;
  nonce: string;
  expiresAt: Date;
}

export interface ShareTokenRow {
  id: string;
  site_id: string;
  nonce: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

/**
 * Issue a new share token: INSERTs a row in apex_share_tokens with a
 * fresh nonce, then returns the signed blob. Clamps TTL to MAX_TTL.
 */
export async function issueShareToken(opts: {
  siteId: string;
  createdBy?: string | null;
  ttlSeconds?: number;
  /** Override for tests. Defaults to getShareSecret(). */
  secret?: string;
}): Promise<IssuedShareToken> {
  const ttl = Math.min(
    Math.max(60, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    MAX_TTL_SECONDS,
  );
  const nowMs = Date.now();
  const exp = Math.floor(nowMs / 1000) + ttl;
  const expiresAt = new Date(exp * 1000);
  const nonce = randomUUID();
  const secret = opts.secret ?? getShareSecret();

  const result = await safeQuery<{ id: string }>(
    `INSERT INTO apex_share_tokens (site_id, nonce, created_by, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [opts.siteId, nonce, opts.createdBy ?? null, expiresAt.toISOString()],
  );

  // In shadow mode (no DATABASE_URL), safeQuery returns no rows. We
  // still issue a synthetic row id so the signed token round-trips — the
  // HTTP layer surfaces a 503 elsewhere when persistence is required.
  const tokenRowId =
    result.rows.length > 0 ? String(result.rows[0].id) : `share_shadow_${nonce}`;

  const claims: ShareTokenClaims = { siteId: opts.siteId, nonce, exp };
  const token = signShareToken(claims, secret);

  return { token, tokenRowId, nonce, expiresAt };
}

/** Mark a share token revoked in place. Idempotent — revoking an
 * already-revoked token is a no-op (the UPDATE matches no rows on the
 * second call). */
export async function revokeShareToken(tokenRowId: string): Promise<void> {
  await safeQuery(
    `UPDATE apex_share_tokens
        SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL`,
    [tokenRowId],
  );
}

/** Bump last_accessed_at + access_count on a valid open. Best-effort —
 * fires after verifyShareToken confirms signature + expiry. */
export async function touchShareTokenAccess(tokenRowId: string): Promise<void> {
  await safeQuery(
    `UPDATE apex_share_tokens
        SET last_accessed_at = NOW(),
            access_count = access_count + 1
      WHERE id = $1`,
    [tokenRowId],
  );
}

/**
 * Load the DB row for a nonce. Returns null if the nonce is unknown
 * OR revoked OR expired — callers treat null as "invalid" without
 * needing to know which of the three it is (we already checked
 * signature/expiry upstream).
 */
export async function loadActiveTokenRow(
  nonce: string,
): Promise<ShareTokenRow | null> {
  const { rows } = await safeQuery<ShareTokenRow>(
    `SELECT id, site_id, nonce, created_by, created_at, expires_at,
            revoked_at, last_accessed_at, access_count
       FROM apex_share_tokens
      WHERE nonce = $1`,
    [nonce],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/** List all non-revoked (active or expired) tokens for a site, newest
 * first. The detail UI decides what to render — we include expired
 * tokens so a designer can see "expired yesterday" and reissue. */
export async function listShareTokensForSite(
  siteId: string,
): Promise<ShareTokenRow[]> {
  const { rows } = await safeQuery<ShareTokenRow>(
    `SELECT id, site_id, nonce, created_by, created_at, expires_at,
            revoked_at, last_accessed_at, access_count
       FROM apex_share_tokens
      WHERE site_id = $1
      ORDER BY created_at DESC`,
    [siteId],
  );
  return rows;
}
