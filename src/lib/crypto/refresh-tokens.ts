/**
 * Refresh-token store for Instinct.
 *
 * Implements family-based rotation:
 *   - On login: create a new family, issue the first refresh token.
 *   - On /api/auth/refresh: mark the old token used, issue a new one in the same family.
 *   - On re-use of a revoked token: revoke the ENTIRE family (detects token theft)
 *     and emit system.refresh_token_reuse_detected.
 *
 * All operations are idempotent — the table uses IF NOT EXISTS and UUIDs.
 */

import { randomUUID } from "crypto";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/** Refresh-token TTL: 7 days in seconds */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
}

/**
 * Issue a new refresh token for a user, optionally in an existing family.
 * Pass familyId to continue a rotation chain; omit to start a new family.
 */
export async function issueRefreshToken(
  userId: string,
  familyId?: string,
): Promise<{ tokenId: string; familyId: string }> {
  const id = randomUUID();
  const fid = familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();

  await query(
    `INSERT INTO instinct_refresh_tokens (id, user_id, family_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, fid, expiresAt],
  );

  return { tokenId: id, familyId: fid };
}

/**
 * Look up a refresh token row. Returns null if not found.
 */
export async function getRefreshToken(tokenId: string): Promise<RefreshTokenRow | null> {
  const result = await query(
    `SELECT id, user_id, family_id, issued_at, expires_at, revoked_at, used_at
     FROM instinct_refresh_tokens
     WHERE id = $1`,
    [tokenId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as RefreshTokenRow;
}

/**
 * Rotate a refresh token:
 *   1. Validate it exists, is not expired, is not revoked, has not been used.
 *   2. Mark it used.
 *   3. Issue a new token in the same family.
 *
 * If the token was already used (re-use attack), revoke the entire family
 * and emit system.refresh_token_reuse_detected.
 *
 * Returns the new token on success; throws on any failure.
 */
export async function rotateRefreshToken(
  tokenId: string,
  userRole: string = "system",
): Promise<{ tokenId: string; familyId: string; userId: string }> {
  const row = await getRefreshToken(tokenId);

  if (!row) {
    throw new Error("refresh_token_not_found");
  }

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    throw new Error("refresh_token_expired");
  }

  // Re-use detection: token was already used → revoke entire family
  if (row.used_at !== null) {
    await revokeFamilyTokens(row.family_id);
    trackEvent(
      "system.refresh_token_reuse_detected",
      row.user_id,
      userRole,
      { user_id: row.user_id, family_id: row.family_id },
    );
    throw new Error("refresh_token_reused");
  }

  // Check if explicitly revoked
  if (row.revoked_at !== null) {
    throw new Error("refresh_token_revoked");
  }

  // Mark old token as used
  await query(
    `UPDATE instinct_refresh_tokens SET used_at = now() WHERE id = $1`,
    [tokenId],
  );

  // Issue new token in the same family
  const newToken = await issueRefreshToken(row.user_id, row.family_id);

  trackEvent(
    "system.refresh_token_rotated",
    row.user_id,
    userRole,
    { user_id: row.user_id, family_id: row.family_id },
  );

  return { tokenId: newToken.tokenId, familyId: newToken.familyId, userId: row.user_id };
}

/**
 * Revoke all tokens in a family (used on theft detection or explicit logout).
 */
export async function revokeFamilyTokens(familyId: string): Promise<void> {
  await query(
    `UPDATE instinct_refresh_tokens
     SET revoked_at = now()
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}

/**
 * Revoke all refresh tokens for a user (logout-all / account compromise response).
 */
export async function revokeUserTokens(userId: string): Promise<void> {
  await query(
    `UPDATE instinct_refresh_tokens
     SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
