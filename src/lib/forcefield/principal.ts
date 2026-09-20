/**
 * Know the Principal - deterministic verification of the human/mandate behind
 * an inbound agent.
 *
 * The market verifies "is this a bot" (Web Bot Auth signs the agent SOFTWARE).
 * The leapfrog is verifying the PRINCIPAL: the human or org accountable for the
 * agent, and the MANDATE (the scopes) they authorized it for. An arriving agent
 * presents a signed delegation credential; we verify it against an issuer the
 * workspace registered, then check the agent's actual behavior against the
 * mandate it presented.
 *
 * Honesty rail (the whole point): a credential is "verified" ONLY when its
 * signature checks out against a registered issuer and it has not expired.
 * Anything short of that - absent, malformed, unknown issuer, bad signature,
 * expired - is "claimed", never "verified". Fail-closed by construction.
 *
 * The strongest possible signal lives here: an agent that presented a VALID
 * mandate and then stepped outside it (mandate_exceeded) had authorization and
 * abused it - worse than an anonymous scraper, which never claimed a right.
 *
 * Reuses OGIAM's own delegation signature construction (verifyDelegationSignature
 * over `${timestamp}.${body}`), so an OGIAM-issued delegation and a Forcefield
 * verification agree byte-for-byte instead of drifting in prose.
 */
import { hasDatabase, query, safeQuery } from "@/lib/db";
import { verifyDelegationSignature } from "@/lib/ogiam/delegate";
import { verifyEs256, type EcPublicJwk } from "@/lib/ogiam/signing";

import {
  type PrincipalStatus,
  type DelegationBody,
  type PrincipalVerdict,
  type DelegationIssuer,
  type MandateCheck,
} from "@/lib/forcefield/principal-types";

export type { PrincipalStatus, DelegationBody, PrincipalVerdict, DelegationIssuer, MandateCheck };
export { scopeMatches, checkMandate } from "@/lib/forcefield/principal-types";

const MAX_CREDENTIAL_BYTES = 8 * 1024;

/** Decode the compact wire form `<base64url(body)>.<timestamp>.<signature>`.
 *  Returns null on any structural problem - a malformed credential is never
 *  verified, only ever "claimed". */
export function parseDelegation(
  raw: string,
): { body: DelegationBody; bodyJson: string; timestamp: number; signature: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CREDENTIAL_BYTES) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [b64, tsStr, signature] = parts;
  const timestamp = Number(tsStr);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !signature) return null;
  let bodyJson: string;
  try {
    bodyJson = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.principal !== "string" || typeof o.issuer !== "string") return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : [];
  const body: DelegationBody = {
    principal: o.principal,
    issuer: o.issuer,
    scopes,
    audience: typeof o.audience === "string" ? o.audience : undefined,
    exp: typeof o.exp === "number" ? o.exp : undefined,
    jti: typeof o.jti === "string" ? o.jti : undefined,
  };
  return { body, bodyJson, timestamp, signature };
}

export interface VerifyDelegationOptions {
  /** Resolve the trusted secret + constraints for an issuer, or null if unknown. */
  resolveIssuer: (issuer: string) => DelegationIssuer | null | Promise<DelegationIssuer | null>;
  /** Current time (epoch seconds). Injected for determinism in tests. */
  nowSeconds: number;
  /** Our expected audience; when set, a mismatch downgrades to "claimed". */
  audience?: string;
  /** Reject a credential whose signing timestamp is older than this many seconds,
   *  bounding the replay window even before the jti check. */
  maxAgeSeconds?: number;
  /** Atomically record the jti and report freshness: resolves true if this jti
   *  was NEWLY recorded (fresh), false if it was already seen (a replay). When
   *  provided, a credential MUST carry a jti, and a replay is rejected. */
  consumeJti?: (jti: string, expiresAtEpoch: number) => Promise<boolean>;
}

/**
 * Verify a presented delegation credential. Fail-closed: only a clean
 * cryptographic verification against a registered issuer yields "verified".
 */
export async function verifyPresentedDelegation(
  raw: string | null | undefined,
  opts: VerifyDelegationOptions,
): Promise<PrincipalVerdict> {
  if (!raw) return { status: "absent", scopes: [], reason: "No delegation credential presented." };

  const parsed = parseDelegation(raw);
  if (!parsed) {
    return { status: "claimed", scopes: [], reason: "Delegation credential was malformed and could not be decoded." };
  }
  const { body, bodyJson, timestamp, signature } = parsed;

  const issuer = await opts.resolveIssuer(body.issuer);
  if (!issuer) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: `Issuer "${body.issuer}" is not a registered, trusted delegation issuer for this workspace.`,
    };
  }

  let signatureOk = false;
  if (issuer.algorithm === "hs256") {
    signatureOk = typeof issuer.secret === "string" && issuer.secret.length > 0
      && verifyDelegationSignature(issuer.secret, bodyJson, timestamp, signature);
  } else if (issuer.algorithm === "es256") {
    // Asymmetric: verify over the SAME `${timestamp}.${bodyJson}` construction as
    // HMAC, so an issuer can move off shared secrets without changing the wire form.
    signatureOk = !!issuer.publicKey && verifyEs256(`${timestamp}.${bodyJson}`, signature, issuer.publicKey as unknown as EcPublicJwk);
  } else {
    // ml-dsa-65-hybrid: the post-quantum slot is reserved but not yet callable, so
    // fail closed (claimed) rather than silently accept.
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Issuer uses the post-quantum algorithm slot, which is not yet enabled for verification.",
    };
  }
  if (!signatureOk) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Delegation signature did not verify against the registered issuer key.",
    };
  }

  if (typeof body.exp === "number" && body.exp <= opts.nowSeconds) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Delegation credential has expired.",
    };
  }

  if (opts.audience && body.audience && body.audience !== opts.audience) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: `Delegation was minted for a different audience ("${body.audience}").`,
    };
  }

  // Bound the replay window: reject a credential signed too long ago.
  if (typeof opts.maxAgeSeconds === "number" && timestamp < opts.nowSeconds - opts.maxAgeSeconds) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Delegation credential is older than the accepted window (stale).",
    };
  }

  // Replay defense: a jti is accepted once. Do this LAST, only after every other
  // check passes, so an invalid credential never consumes a jti.
  if (opts.consumeJti) {
    if (!body.jti) {
      return {
        status: "claimed",
        principal: body.principal,
        issuer: body.issuer,
        scopes: [],
        reason: "Delegation is missing a jti, so it cannot be protected against replay.",
      };
    }
    const fresh = await opts.consumeJti(body.jti, typeof body.exp === "number" ? body.exp : opts.nowSeconds + 3600);
    if (!fresh) {
      return {
        status: "claimed",
        principal: body.principal,
        issuer: body.issuer,
        scopes: [],
        reason: "Delegation credential has already been used (replay).",
      };
    }
  }

  // Defense in depth: an issuer may cap the scopes it is ever allowed to grant.
  const scopes =
    issuer.allowedScopes.length > 0
      ? body.scopes.filter((s) => issuer.allowedScopes.includes(s))
      : body.scopes;

  return {
    status: "verified",
    principal: body.principal,
    issuer: body.issuer,
    scopes,
    audience: body.audience,
    reason: "Signature verified against a registered issuer; the principal and mandate are proven.",
  };
}

// ── Issuer registry (workspace-scoped) ───────────────────────────────────────

/** Load one trusted issuer for a workspace, or null. Never throws. */
export async function getDelegationIssuer(
  workspaceId: string,
  issuer: string,
): Promise<DelegationIssuer | null> {
  if (!hasDatabase()) return null;
  const res = await safeQuery<{ issuer: string; algorithm: string; secret: string | null; public_key: Record<string, unknown> | null; allowed_scopes: string[] }>(
    `SELECT issuer, algorithm, secret, public_key, allowed_scopes
       FROM instinct_delegation_issuers
      WHERE workspace_id = $1 AND issuer = $2
      LIMIT 1`,
    [workspaceId, issuer],
  );
  const row = res?.rows[0];
  if (!row) return null;
  const algorithm = row.algorithm === "es256" ? "es256" : row.algorithm === "ml-dsa-65-hybrid" ? "ml-dsa-65-hybrid" : "hs256";
  return { issuer: row.issuer, algorithm, secret: row.secret, publicKey: row.public_key, allowedScopes: row.allowed_scopes ?? [] };
}

/** List a workspace's trusted issuers WITHOUT their secrets (for the admin UI). */
export async function listDelegationIssuers(
  workspaceId: string,
): Promise<Array<{ issuer: string; algorithm: string; allowedScopes: string[]; createdAt: string }>> {
  if (!hasDatabase()) return [];
  const res = await safeQuery<{ issuer: string; algorithm: string; allowed_scopes: string[]; created_at: string }>(
    `SELECT issuer, algorithm, allowed_scopes, created_at
       FROM instinct_delegation_issuers
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return (res?.rows ?? []).map((r) => ({
    issuer: r.issuer,
    algorithm: r.algorithm,
    allowedScopes: r.allowed_scopes ?? [],
    createdAt: r.created_at,
  }));
}

/** Register (or rotate) a trusted issuer for a workspace. Upsert on (ws, issuer). */
export async function registerDelegationIssuer(input: {
  workspaceId: string;
  issuer: string;
  /** hs256 shared secret. Provide this OR publicKey. */
  secret?: string;
  /** es256 public key (JWK). Provide this to register an ASYMMETRIC issuer - no
   *  shared secret to leak, and the on-ramp to the PQ (ml-dsa) slot. */
  publicKey?: Record<string, unknown>;
  allowedScopes?: string[];
  createdBy?: string;
}): Promise<void> {
  if (!hasDatabase()) return;
  const algorithm = input.publicKey ? "es256" : "hs256";
  await query(
    `INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret, public_key, allowed_scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, issuer) DO UPDATE
       SET algorithm = EXCLUDED.algorithm, secret = EXCLUDED.secret, public_key = EXCLUDED.public_key,
           allowed_scopes = EXCLUDED.allowed_scopes, updated_at = now()`,
    [input.workspaceId, input.issuer, algorithm, input.secret ?? null, input.publicKey ? JSON.stringify(input.publicKey) : null, input.allowedScopes ?? [], input.createdBy ?? null],
  );
}

/**
 * Replay store: atomically record a jti and report whether it was FRESH. Backed
 * by instinct_delegation_replay; the PK makes the insert the atomic check (a
 * duplicate jti conflicts and touches zero rows -> replay). Rows self-expire at
 * the credential's own expiry, so the table stays small.
 */
export async function consumeDelegationJti(workspaceId: string, jti: string, expiresAtEpoch: number): Promise<boolean> {
  if (!hasDatabase()) return true; // no store -> cannot dedupe; treat as fresh (verification still gated by signature)
  const res = await safeQuery<{ jti: string }>(
    `INSERT INTO instinct_delegation_replay (jti, workspace_id, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     ON CONFLICT (jti) DO NOTHING
     RETURNING jti`,
    [jti, workspaceId, expiresAtEpoch],
  );
  return (res?.rows.length ?? 0) > 0; // a row returned => newly inserted => fresh
}
