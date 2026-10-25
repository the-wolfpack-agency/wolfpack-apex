/**
 * mfa-proof.ts - the "this browser passed an MFA challenge" proof.
 *
 * After a confirmed enrollment passes a challenge (or a fresh enrollment is
 * confirmed), the server sets an HttpOnly cookie carrying a sealed proof. The
 * MFA gate in requireCapability accepts an admin-capable request only when that
 * proof is present, unexpired, issued to the SAME user, and bound to the SAME
 * enrollment (its confirmed_at). Re-enrolling or disabling MFA changes or
 * removes confirmed_at, so every proof issued for the old enrollment stops
 * working without anyone having to track them.
 *
 * WHY A SEALED BLOB AND NOT A JWT. Anything this repo signs as a JWT with the
 * session key is accepted by getUserFromRequest as a candidate session. A proof
 * must never be usable as a session, so it is sealed with secret-storage.ts
 * (AES-256-GCM, authenticated) instead: it cannot be forged, read, or replayed
 * as a bearer token, and tampering fails the GCM tag.
 *
 * WHY A COOKIE AND NOT A CLAIM IN THE ACCESS TOKEN. Access tokens are re-minted
 * every 15 minutes by /api/auth/refresh, which knows nothing about MFA. A claim
 * would be dropped on the first refresh and every admin re-challenged four
 * times an hour. The cookie lives as long as the refresh token does (7 days),
 * which makes it the familiar "trust this browser for 7 days".
 */

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-storage";
import { REFRESH_TOKEN_TTL_SECONDS } from "@/lib/crypto/cookies";

export const MFA_PROOF_COOKIE = "instinct_mfa_proof";
export const MFA_PROOF_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS;

const PURPOSE = "mfa_proof:v1";

interface ProofBody {
  p: string; // purpose tag, so no other sealed value can stand in for a proof
  u: string; // user id
  c: number; // enrollment confirmed_at (ms) the proof is bound to
  e: number; // expiry (ms)
}

/** Seal a proof for `userId` bound to the enrollment confirmed at `confirmedAtMs`. */
export function issueMfaProof(params: {
  userId: string;
  confirmedAtMs: number;
  nowMs?: number;
  ttlSeconds?: number;
}): string {
  const now = params.nowMs ?? Date.now();
  const body: ProofBody = {
    p: PURPOSE,
    u: params.userId,
    c: params.confirmedAtMs,
    e: now + (params.ttlSeconds ?? MFA_PROOF_TTL_SECONDS) * 1000,
  };
  const sealed = encryptSecret(JSON.stringify(body));
  if (!sealed.startsWith("v1.")) throw new Error("mfa proof could not be sealed");
  return sealed;
}

/**
 * True only for a proof that authenticates, carries the proof purpose, names
 * this user, is bound to this enrollment, and has not expired.
 */
export function verifyMfaProof(
  token: string | null | undefined,
  expected: { userId: string; confirmedAtMs: number; nowMs?: number },
): boolean {
  if (!token || typeof token !== "string" || !token.startsWith("v1.")) return false;
  const raw = decryptSecret(token);
  if (!raw) return false;
  let body: Partial<ProofBody>;
  try {
    body = JSON.parse(raw) as Partial<ProofBody>;
  } catch {
    return false;
  }
  if (body.p !== PURPOSE) return false;
  if (body.u !== expected.userId) return false;
  if (typeof body.c !== "number" || body.c !== expected.confirmedAtMs) return false;
  if (typeof body.e !== "number" || body.e <= (expected.nowMs ?? Date.now())) return false;
  return true;
}
