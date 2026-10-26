/**
 * invite-tokens.ts - team invite tokens are stored as their SHA-256 hash
 * (token-hash.ts). This file owns the lookup the accept route uses and the
 * backfill (scripts/hash-invite-tokens.ts) that converts stored tokens, so
 * both are tested against a real Postgres
 * (src/db/__tests__/invite-token-hash.db.test.ts).
 *
 * New invites are hashed at rest from the moment they are created, and an
 * invite is hashed when it is accepted. /api/team/accept also matches an
 * invite not converted yet, so outstanding links keep working; after this
 * runs every row holds a hash.
 *
 *   - Needs no key: hashing is one-way and keyless.
 *   - Each UPDATE is conditional on the row still holding the value read, so
 *     a concurrent accept or resend always wins.
 *   - Idempotent: a hashed value is recognised by shape and never re-hashed.
 *   - Nothing here returns or logs a token.
 */
import type { ClientBase } from "pg";
import { HASHED_TOKEN_SQL_PATTERN, hashBearerToken, isHashedBearerToken } from "@/lib/crypto/token-hash";

/**
 * Find an invite by the token presented in an accept link. Matches the hash
 * of the presented token. An invite not converted yet is matched directly,
 * but ONLY when the stored value is not itself a hash: presenting a hash
 * string must never open a hashed invite.
 */
export const INVITE_BY_TOKEN_SQL = `SELECT id, email, role, status, invited_by, expires_at, workspace_id FROM instinct_invites
      WHERE token = $1 OR (token = $2 AND token !~ '${HASHED_TOKEN_SQL_PATTERN}') LIMIT 1`;

export function inviteLookupParams(presented: string): [string, string] {
  return [hashBearerToken(presented), presented];
}

export interface InviteHashReport {
  present: boolean;
  applied: boolean;
  rows: number;
  alreadyHashed: number;
  toHash: number;
  hashed: number;
  /** Rows the app changed between read and write; the app's value kept. */
  skippedConcurrent: number;
  failed: number;
}

export async function hashInviteTokens(db: ClientBase, opts: { apply: boolean }): Promise<InviteHashReport> {
  const report: InviteHashReport = { present: true, applied: false, rows: 0, alreadyHashed: 0, toHash: 0, hashed: 0, skippedConcurrent: 0, failed: 0 };
  let rows: { id: string; workspace_id: string | null; token: string }[];
  try {
    /* Every workspace on purpose: a storage-format conversion, not a read of
       anyone's data (workspace_id is selected to say so). */
    rows = (await db.query(`SELECT id, workspace_id, token FROM instinct_invites ORDER BY id`)).rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      report.present = false;
      return report;
    }
    throw err;
  }
  report.rows = rows.length;
  const planned = rows.filter((r) => {
    if (isHashedBearerToken(r.token)) {
      report.alreadyHashed++;
      return false;
    }
    return true;
  });
  report.toHash = planned.length;
  if (!opts.apply) return report;

  report.applied = true;
  for (const r of planned) {
    const res = await db.query(`UPDATE instinct_invites SET token = $1 WHERE id = $2 AND token = $3`, [hashBearerToken(r.token), r.id, r.token]);
    if ((res.rowCount ?? 0) > 0) report.hashed++;
    else report.skippedConcurrent++;
  }
  report.failed = report.skippedConcurrent;
  if (report.hashed > 0) {
    await db
      .query(`INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ($1, 'system', 'system', $2, $3)`, [
        "security.invite_tokens_hashed",
        JSON.stringify({ hashed: report.hashed, already_hashed: report.alreadyHashed, source: "operator_script" }),
        new Date().toISOString(),
      ])
      .catch(() => {});
  }
  return report;
}
