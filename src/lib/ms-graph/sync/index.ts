/**
 * Unified MS Graph canonical-mirror dispatcher.
 *
 * Runs every per-entity worker sequentially for a given user, collects
 * their results, and returns a single aggregate summary. Per-worker
 * exceptions are intentionally caught at the worker level (see
 * ./common.ts `errorToResult`), so this dispatcher never has to handle
 * "one worker threw" itself — each worker always resolves to a typed
 * `SyncWorkerResult` with optional `error` field.
 *
 * Why sequential instead of Promise.all?
 *   - All five workers share the same MS Graph token. Running them in
 *     parallel multiplies the probability of tripping the Graph 429
 *     per-app throttle, and when one does trip we want the others to
 *     get their Retry-After breathing room, not pile on.
 *   - DB writeQuery calls go through the shared pg pool (max=10). The
 *     tasks worker can traverse many lists on first sync; parallelism
 *     would starve other app traffic.
 *
 * If one worker needs to be disabled (e.g., admin consent not yet
 * granted for a scope AND the org wants to skip Graph altogether for
 * that entity), pass `only: ["events", "tasks"]` — workers not in the
 * list simply do not run; omitted from the summary.
 */

import { syncUser as syncEvents } from "./events";
import { syncUser as syncTasks } from "./tasks";
import { syncUser as syncMessages } from "./messages";
import { syncUser as syncContacts } from "./contacts";
import { syncUser as syncFiles } from "./files";
import type { MsEntityType, SyncWorkerResult } from "./common";

/** The five canonical workers keyed by their entity type. */
export const WORKERS: Record<
  MsEntityType,
  (userId: string) => Promise<SyncWorkerResult>
> = {
  events: syncEvents,
  tasks: syncTasks,
  messages: syncMessages,
  contacts: syncContacts,
  files: syncFiles,
};

export interface SyncAllOptions {
  only?: MsEntityType[];
}

export interface SyncAllResult {
  userId: string;
  totalCreated: number;
  totalUpdated: number;
  totalDeleted: number;
  totalDurationMs: number;
  results: SyncWorkerResult[];
  /** Entity types whose worker returned an error field (partial failure). */
  failedEntityTypes: MsEntityType[];
}

/**
 * Run every canonical sync worker for `userId`. Never throws — every
 * worker's outcome shows up in `results[]` with an optional `error`
 * field. Analytics events are emitted by the workers themselves
 * (`ms_sync.user_synced`, `ms_sync.scope_missing`, `ms_sync.error`,
 * `ms_sync.rate_limited`).
 */
export async function syncAllEntities(
  userId: string,
  opts: SyncAllOptions = {},
): Promise<SyncAllResult> {
  const start = Date.now();
  const selected = (opts.only && opts.only.length > 0
    ? opts.only
    : (Object.keys(WORKERS) as MsEntityType[]));

  const results: SyncWorkerResult[] = [];
  for (const entity of selected) {
    const worker = WORKERS[entity];
    if (!worker) continue;

    // Defensive: even though every worker already catches its own
    // errors via errorToResult, we wrap in a last-line try/catch so a
    // bug in the worker itself (not a Graph error) cannot cascade.
    try {
      results.push(await worker(userId));
    } catch (err) {
      results.push({
        entityType: entity,
        created: 0,
        updated: 0,
        deleted: 0,
        durationMs: 0,
        error: "unknown",
        errorMessage: (err as Error).message,
      });
    }
  }

  const totalCreated = results.reduce((a, r) => a + r.created, 0);
  const totalUpdated = results.reduce((a, r) => a + r.updated, 0);
  const totalDeleted = results.reduce((a, r) => a + r.deleted, 0);
  const failedEntityTypes = results
    .filter((r) => r.error)
    .map((r) => r.entityType);

  return {
    userId,
    totalCreated,
    totalUpdated,
    totalDeleted,
    totalDurationMs: Date.now() - start,
    results,
    failedEntityTypes,
  };
}

export type { SyncWorkerResult, MsEntityType } from "./common";
