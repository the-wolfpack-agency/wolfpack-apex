/**
 * Whose Microsoft token the scheduled repair borrows.
 *
 * THE GAP THIS CLOSES. The repair endpoint runs as `{ id: "cron" }` on the
 * scheduled path, which is right for the audit row: the system did it, not
 * whoever last logged in. But the download then calls getValidToken("cron"),
 * and "cron" has never completed an OAuth flow, so it can never have a token.
 * Every scheduled run since the job was written threw no_token on its first
 * document and was structurally guaranteed to.
 *
 * Reconnecting Microsoft would not have fixed it. That is the part worth being
 * clear about, because the obvious reading of "re-fetch failed: no_token" is
 * that somebody's session lapsed.
 *
 * WHY BORROWING A USER RATHER THAN APP-ONLY AUTH. App-only would be the
 * cleaner answer and needs Files.Read.All as an application permission plus
 * tenant admin consent, which is a decision for whoever owns the tenant rather
 * than something to grant ourselves inside a repair job. Borrowing a delegated
 * token that already exists changes no permission and grants no new access:
 * the repair can read exactly the drives that person can read, which is the
 * same boundary the original ingest ran under.
 *
 * IT PICKS DELIBERATELY, NOT ARBITRARILY. The most recently connected account
 * with a live token, because that is the one most likely to still be valid on
 * the next run too. The choice is returned rather than hidden so the audit row
 * can name whose access was used, which matters: a repair that rewrites a
 * document library under a borrowed identity should say whose.
 */

import { query } from "@/lib/db";

export interface RepairIdentity {
  /** The account whose delegated token the repair will use. */
  userEmail: string;
  /** When that token expires, so a caller can say how much runway is left. */
  expiresAt: string;
}

/**
 * The freshest connected Microsoft account, or null when there is none.
 *
 * Null is a real answer and the caller must treat it as one: it means nobody
 * has connected Microsoft, which no amount of retrying resolves.
 */
export async function findRepairIdentity(): Promise<RepairIdentity | null> {
  try {
    const { rows } = await query<{ user_email: string; expires_at: string }>(
      `SELECT user_email, expires_at::text AS expires_at
         FROM instinct_ms_tokens
        WHERE refresh_token IS NOT NULL
        ORDER BY expires_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return { userEmail: row.user_email, expiresAt: row.expires_at };
  } catch {
    /* silent-ok: an unreadable token table and an empty one lead to the same
       decision here, which is to refuse the run and say why. The caller
       reports it; a throw would only turn a clear refusal into a stack trace. */
    return null;
  }
}

/**
 * Why a repair cannot run, phrased for whoever has to act on it.
 *
 * Written here rather than at the call site because the fix is the same
 * sentence every time, and a job that says "no_token" sends somebody looking
 * at the wrong thing.
 */
export const NO_IDENTITY_MESSAGE =
  "No Microsoft account is connected, so there is nothing to re-download files with. " +
  "Connect Microsoft from the app once and the next run will drain the queue.";
