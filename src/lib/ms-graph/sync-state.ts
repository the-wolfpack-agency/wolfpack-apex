/**
 * Whether we have ever looked, as distinct from whether there is anything.
 *
 * THE BUG THIS EXISTS FOR. Every Microsoft mirror table in production is
 * empty. Measured 2026-08-28: instinct_ms_tasks 0 rows, instinct_ms_events 0,
 * instinct_ms_messages 0, instinct_ms_files 0, against six connected accounts
 * whose tokens refresh successfully 15,855 times over. instinct_ms_sync_cursors
 * has never held a row for any user or any entity, because vercel.json runs
 * twenty cron jobs and not one of them syncs Graph. The sync worker is well
 * built and its own docstring asks for "an external poller every 10 minutes
 * per-user". That poller was never written.
 *
 * The read paths do not know any of this. They query an empty table, get an
 * empty list, and the assistant says:
 *
 *   "You have no open tasks. Nice."
 *
 * to somebody with a full To-Do list. It is confident, cheerful, and false, and
 * it is the single most damaging shape of answer this product can produce,
 * because the reader has no way to tell it apart from the truth.
 *
 * THE SAME RULE AS EVERYWHERE ELSE IN THIS CODEBASE. The pilot dashboard
 * distinguishes unreadable from zero. The Brain distinguishes "not connected
 * yet" from "no results". The capability answer distinguishes "your role
 * cannot" from "the product cannot". This is that rule applied one layer
 * lower, at the mirror: an empty table means "we have never looked" until a
 * sync says otherwise, and the two sentences lead to opposite actions.
 *
 * WHY A CURSOR ROW IS THE RIGHT SIGNAL. It is written by the sync worker
 * itself, on success, as part of the same transaction that stores the delta
 * link. It cannot be true unless a sync genuinely completed, and it cannot
 * silently drift the way a separate "has synced" flag would. Absence is
 * unambiguous: nothing has ever run.
 */

import { safeQuery } from "@/lib/db";
import type { MsEntityType } from "@/lib/ms-graph/sync/common";

/**
 * The entity kinds the mirror syncs, taken from the sync worker rather than
 * restated. Written first as a second literal union that said "mail" where the
 * worker says "messages", which would have queried a cursor row that can never
 * exist and reported every mailbox as never-synced forever.
 */
export type SyncedEntity = MsEntityType;

export interface SyncState {
  /** True once a sync has completed for this user and entity, ever. */
  everSynced: boolean;
  /** When it last completed, or null if it never has. */
  lastSyncedAt: Date | null;
}

/** Never synced. Returned on a read failure too: see whyNotZero below. */
const NEVER: SyncState = { everSynced: false, lastSyncedAt: null };

/**
 * Has this user's <entity> ever been synced from Graph?
 *
 * A FAILED READ REPORTS NEVER, DELIBERATELY. The only thing a caller does with
 * this is decide between "you have none" and "we have not looked yet", and if
 * we cannot tell, the second is the honest one. Claiming a sync we cannot
 * evidence is how the original bug reads.
 */
export async function getSyncState(
  userId: string,
  entity: SyncedEntity,
): Promise<SyncState> {
  if (!userId) return NEVER;
  try {
    const { rows } = await safeQuery<{ last_synced_at: string | null }>(
      `SELECT last_synced_at
         FROM instinct_ms_sync_cursors
        WHERE user_id = $1 AND entity_type = $2
        LIMIT 1`,
      [userId, entity],
    );
    const row = rows[0];
    if (!row) return NEVER;
    return {
      everSynced: true,
      lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
    };
  } catch {
    return NEVER;
  }
}

/**
 * What to say when a Graph-backed list came back empty.
 *
 * Returns null when the emptiness is real and the caller should use its own
 * "you have none" copy. Returns a sentence when it is not.
 *
 * NAMES THE NEXT STEP, NEVER JUST THE PROBLEM. "Not synced" on its own leaves
 * somebody holding a correct sentence they cannot act on, which is the failure
 * the roster lookup had before it started naming the roles it does record.
 */
export async function unsyncedNotice(
  userId: string,
  entity: SyncedEntity,
  /** What a person calls this, e.g. "tasks", "meetings", "emails". */
  noun: string,
): Promise<string | null> {
  const state = await getSyncState(userId, entity);
  if (state.everSynced) return null;
  return (
    `Your Microsoft ${noun} have not been synced yet, so I cannot tell you ` +
    `whether there are any. Connect Microsoft 365 in Settings if you have not, ` +
    `and I will be able to answer this.`
  );
}
