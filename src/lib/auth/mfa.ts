/**
 * mfa.ts — Admin MFA (TOTP) core. OPT-IN, SELF-SERVICE, NON-ENFORCING.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SAFETY CONTRACT (this PR):
 *   This module implements enrollment + verification + status ONLY. It is
 *   imported by the /api/auth/mfa/* routes and the settings UI. It is NOT
 *   imported by src/middleware.ts, the login route, require-capability's gate,
 *   or the refresh flow. The ABSENCE of an MFA enrollment never blocks any
 *   existing flow. Enforcement (requiring a TOTP at login) is a deliberate
 *   later PR behind a flag, once adoption is proven — zero lockout risk now.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * TOTP implementation choice: NATIVE node:crypto (HMAC-SHA1 per RFC 6238 /
 * RFC 4226 HOTP), ~40 lines, NO new runtime dependency.
 *
 *   Why not `speakeasy` / `otplib`? CLAUDE.md forbids new runtime deps without
 *   strong justification, and TOTP is a small, fully-specified algorithm:
 *     - RFC 4226 (HOTP): HOTP(K, C) = Truncate(HMAC-SHA1(K, C)).
 *     - RFC 6238 (TOTP): TOTP = HOTP(K, floor((T - T0) / X)), X = 30s.
 *   Implementing it natively is auditable end to end (no transitive supply
 *   chain), and the verifier below is the only place codes are checked.
 *
 * Security properties built in:
 *   - Constant-time comparison (timingSafeEqual) for every code check, so a
 *     wrong code cannot be distinguished by timing.
 *   - +/-1 time-step window (prev/current/next) for clock skew, per RFC 6238
 *     §5.2 recommendation, no wider (a wide window weakens the OTP).
 *   - Secret stored ENCRYPTED at rest (secret-storage.ts AES-256-GCM); never
 *     plaintext. Recovery codes stored only as SHA-256 HASHES; shown once.
 */

import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { query } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { DEFAULT_WORKSPACE_ID } from "@/lib/auth";

// ──────────────────────────────────────────────────────────────────────────
// RFC 6238 / 4226 constants
// ──────────────────────────────────────────────────────────────────────────

const STEP_SECONDS = 30; // RFC 6238 default time step (X).
const CODE_DIGITS = 6; // RFC 6238 default.
const SKEW_STEPS = 1; // accept prev/current/next step for clock skew.
const SECRET_BYTES = 20; // 160-bit secret (RFC 4226 §4 recommends >= 128 bits; 160 = SHA-1 block-aligned).
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5; // 10 hex chars per code.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32.

// ──────────────────────────────────────────────────────────────────────────
// base32 (RFC 4648, no padding) — authenticator apps consume base32 secrets
// ──────────────────────────────────────────────────────────────────────────

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // skip stray chars defensively
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ──────────────────────────────────────────────────────────────────────────
// HOTP / TOTP — RFC 4226 §5.3 dynamic truncation + RFC 6238 time counter
// ──────────────────────────────────────────────────────────────────────────

/** HOTP(K, C): HMAC-SHA1 then dynamic-truncate to CODE_DIGITS, RFC 4226 §5.3. */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. JS bitwise is 32-bit, so write hi/lo halves.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** CODE_DIGITS;
  return otp.toString().padStart(CODE_DIGITS, "0");
}

/** The current time-step counter, T = floor((now - T0) / X), T0 = 0. */
function currentStep(atMs: number): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * Generate the TOTP code for a base32 secret at a given step offset from now.
 * Exposed primarily so tests can generate a valid code without re-deriving the
 * algorithm; the verifier below is what production trusts.
 */
export function totpForSecret(
  base32Secret: string,
  opts: { atMs?: number; stepOffset?: number } = {},
): string {
  const atMs = opts.atMs ?? Date.now();
  const step = currentStep(atMs) + (opts.stepOffset ?? 0);
  return hotp(base32Decode(base32Secret), step);
}

/**
 * Verify a user-supplied code against the base32 secret with a +/-SKEW_STEPS
 * window. Uses constant-time comparison so a near-miss code cannot be timed.
 * Returns true iff the code matches the prev, current, or next step.
 *
 * NON-ENFORCING note: this is only ever called from the /api/auth/mfa/verify
 * route during opt-in enrollment confirmation (and reserved for a later
 * enforcement PR). It does not gate any current login.
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  opts: { atMs?: number } = {},
): boolean {
  if (typeof code !== "string") return false;
  const candidate = code.trim();
  if (!/^\d{6}$/.test(candidate)) return false;
  const atMs = opts.atMs ?? Date.now();
  const secret = base32Decode(base32Secret);
  const base = currentStep(atMs);
  let ok = false;
  // Iterate the WHOLE window regardless of an early match so total work is
  // independent of which step matched (no early-return timing signal).
  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
    const expected = hotp(secret, base + offset);
    if (constantTimeEquals(expected, candidate)) ok = true;
  }
  return ok;
}

/** Length-safe constant-time string compare (timingSafeEqual needs equal len). */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a compare against a same-length buffer to avoid a length oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ──────────────────────────────────────────────────────────────────────────
// Secret + recovery codes
// ──────────────────────────────────────────────────────────────────────────

/** Fresh 160-bit base32 secret for a new enrollment. */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * otpauth:// URI per the Key URI Format (de-facto standard consumed by Google
 * Authenticator / 1Password / Authy). The authenticator app renders this as a
 * QR code; we hand the raw URI to the client and let it draw the QR (no QR
 * library dependency server-side).
 */
export function otpauthUrl(params: {
  secret: string;
  account: string; // user email / login
  issuer?: string;
}): string {
  const issuer = params.issuer ?? "Wolfpack Instinct";
  const label = encodeURIComponent(`${issuer}:${params.account}`);
  const q = new URLSearchParams({
    secret: params.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Generate N single-use recovery codes (plaintext, shown to the user once). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 hex chars, hyphenated for readability: e.g. "a1b2c-3d4e5".
    const hex = randomBytes(RECOVERY_CODE_BYTES).toString("hex");
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return codes;
}

/** One-way hash of a recovery code for at-rest storage. Normalizes case/dashes. */
export function hashRecoveryCode(code: string): string {
  const normalized = code.trim().toLowerCase().replace(/-/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────
// Persistence — instinct_admin_mfa (migration 216)
// ──────────────────────────────────────────────────────────────────────────

export interface MfaStatus {
  enrolled: boolean; // a row exists (pending OR confirmed)
  confirmed: boolean; // confirmed_at is set
  recoveryCodesRemaining: number;
  confirmedAt: string | null;
}

interface MfaRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  workspace_id: string;
  encrypted_secret: string;
  confirmed_at: string | null;
  recovery_code_hashes: string[];
}

function mfaId(userId: string): string {
  // Deterministic per-user id (one enrollment per user). Hash so the raw user
  // id isn't echoed in the PK, matching the "mfa_<hash>" family convention.
  return "mfa_" + createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

/**
 * Begin (or restart) an enrollment: generate a fresh secret, persist it
 * ENCRYPTED, clear any prior confirmation, and return the secret + otpauth URL
 * for the client to display. The secret is returned plaintext to the client
 * exactly once here (it must be, to seed the authenticator) but is NEVER stored
 * plaintext. Returns null only on a write failure.
 */
export async function enrollMfa(params: {
  userId: string;
  workspaceId?: string;
  account: string;
}): Promise<{ secret: string; otpauthUrl: string } | null> {
  const secret = generateSecret();
  const encrypted = encryptSecret(secret);
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = mfaId(params.userId);

  if (!process.env.DATABASE_URL) {
    // Shadow mode (no DB): return a usable secret so the UI/flow works in dev.
    return { secret, otpauthUrl: otpauthUrl({ secret, account: params.account }) };
  }

  try {
    await query(
      `INSERT INTO instinct_admin_mfa
         (id, user_id, workspace_id, encrypted_secret, confirmed_at, recovery_code_hashes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, '{}', NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET encrypted_secret = EXCLUDED.encrypted_secret,
             confirmed_at = NULL,
             recovery_code_hashes = '{}',
             updated_at = NOW()`,
      [id, params.userId, workspaceId, encrypted],
    );
    return { secret, otpauthUrl: otpauthUrl({ secret, account: params.account }) };
  } catch (err) {
    console.warn("[mfa] enroll write failed:", (err as Error).message);
    return null;
  }
}

async function loadRow(userId: string, workspaceId: string): Promise<MfaRow | null> {
  if (!process.env.DATABASE_URL) return null;
  // Workspace + user scoped: a caller can only ever touch THEIR OWN row. The
  // route derives userId/workspaceId from the verified JWT, never from input,
  // so there is no IDOR surface.
  const { rows } = await query<MfaRow>(
    `SELECT id, user_id, workspace_id, encrypted_secret, confirmed_at, recovery_code_hashes
       FROM instinct_admin_mfa
      WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return rows[0] ?? null;
}

/**
 * Confirm a pending enrollment with a TOTP code. On success: mark confirmed,
 * generate + persist HASHED recovery codes, and return the plaintext recovery
 * codes (shown to the user exactly once). On a bad/expired code, returns
 * { ok: false } and writes nothing.
 */
export async function confirmMfa(params: {
  userId: string;
  workspaceId?: string;
  code: string;
}): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: "no_enrollment" | "bad_code" }> {
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await loadRow(params.userId, workspaceId);
  if (!row) return { ok: false, reason: "no_enrollment" };

  const secret = decryptSecret(row.encrypted_secret);
  if (!secret) return { ok: false, reason: "no_enrollment" };

  if (!verifyTotp(secret, params.code)) {
    return { ok: false, reason: "bad_code" };
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashes = recoveryCodes.map(hashRecoveryCode);

  await query(
    `UPDATE instinct_admin_mfa
        SET confirmed_at = NOW(), recovery_code_hashes = $3, updated_at = NOW()
      WHERE user_id = $1 AND workspace_id = $2`,
    [params.userId, workspaceId, hashes],
  );

  return { ok: true, recoveryCodes };
}

/**
 * Verify a code (TOTP or single-use recovery code) for a CONFIRMED enrollment.
 * Recovery codes are consumed in place (the matching hash is removed). Reserved
 * for the later enforcement PR + used by tests; not wired into any login today.
 */
export async function verifyMfaCode(params: {
  userId: string;
  workspaceId?: string;
  code: string;
}): Promise<{ ok: boolean; usedRecoveryCode: boolean }> {
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await loadRow(params.userId, workspaceId);
  if (!row || !row.confirmed_at) return { ok: false, usedRecoveryCode: false };

  const secret = decryptSecret(row.encrypted_secret);
  if (secret && verifyTotp(secret, params.code)) {
    return { ok: true, usedRecoveryCode: false };
  }

  // Recovery-code path: constant-time match against each stored hash.
  const candidate = hashRecoveryCode(params.code);
  const remaining = row.recovery_code_hashes ?? [];
  let matchedIndex = -1;
  for (let i = 0; i < remaining.length; i++) {
    if (constantTimeEquals(remaining[i], candidate)) matchedIndex = i;
  }
  if (matchedIndex === -1) return { ok: false, usedRecoveryCode: false };

  const next = remaining.filter((_, i) => i !== matchedIndex);
  await query(
    `UPDATE instinct_admin_mfa
        SET recovery_code_hashes = $3, updated_at = NOW()
      WHERE user_id = $1 AND workspace_id = $2`,
    [params.userId, workspaceId, next],
  );
  return { ok: true, usedRecoveryCode: true };
}

/** Disable MFA for the caller: delete their enrollment row. Idempotent. */
export async function disableMfa(params: {
  userId: string;
  workspaceId?: string;
}): Promise<{ wasEnrolled: boolean }> {
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!process.env.DATABASE_URL) return { wasEnrolled: false };
  const { rowCount } = await query(
    `DELETE FROM instinct_admin_mfa WHERE user_id = $1 AND workspace_id = $2`,
    [params.userId, workspaceId],
  );
  return { wasEnrolled: (rowCount ?? 0) > 0 };
}

/** Read enrollment status for the caller. Never throws — read-only. */
export async function mfaStatus(params: {
  userId: string;
  workspaceId?: string;
}): Promise<MfaStatus> {
  const workspaceId = params.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = await loadRow(params.userId, workspaceId);
  if (!row) {
    return { enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null };
  }
  return {
    enrolled: true,
    confirmed: !!row.confirmed_at,
    recoveryCodesRemaining: (row.recovery_code_hashes ?? []).length,
    confirmedAt: row.confirmed_at,
  };
}
