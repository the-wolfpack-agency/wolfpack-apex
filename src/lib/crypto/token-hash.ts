/**
 * token-hash.ts - one-way storage for bearer tokens that are only ever
 * compared, never shown back (team invite tokens).
 *
 * The raw token goes to its recipient once (the invite email and the creating
 * admin's response). The database holds SHA-256 hex of it, the same scheme
 * instinct_password_resets.token_sha256 uses. A lookup hashes the presented
 * token. The tokens are 122-bit random UUIDs, so an unsalted fast hash is the
 * right tool: there is nothing to brute-force.
 *
 * A stored hash is exactly 64 lowercase hex characters. A raw invite token is
 * a hyphenated UUID, so the two forms can never be confused.
 */
import { createHash } from "node:crypto";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** SHA-256 hex of a bearer token, for storage and lookup. */
export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when a stored value is already a hash (not a raw token). */
export function isHashedBearerToken(stored: string | null | undefined): boolean {
  return typeof stored === "string" && SHA256_HEX.test(stored);
}

/** SQL fragment shared by every lookup: a stored value that is a hash. Kept
 *  here so the lookup and the backfill can never disagree on the shape. */
export const HASHED_TOKEN_SQL_PATTERN = "^[0-9a-f]{64}$";
