/**
 * Index a whole granted SharePoint estate, not one hand-picked folder.
 *
 * WHY THIS EXISTS. Connecting a source is not indexing it: each source has to
 * be synced, and there was no way to sync them all. So a client who granted us
 * their whole SharePoint saw only the folders someone had synced by hand. This
 * walks every ACTIVE connected source and runs the existing, proven
 * `syncSource` on each, so the entire granted estate lands in the library.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. Only the ingest/connector path. It reuses
 * `syncSource` unchanged; it does not import or alter the assistant, the router,
 * the gate, retrieval, or any UI. Indexing more documents cannot change an
 * answer that already worked, because retrieval scopes by estate + audience and
 * this only ADDS rows (deduped by sha256). Estate is carried per source, so the
 * client's Phase-1 figures stay clean as the estate grows. The import-boundary
 * test in __tests__/sync-all.boundary.test.ts enforces the "ingest path only"
 * promise so a future edit cannot quietly couple this to the assistant.
 *
 * SAFETY POSTURE.
 *  - Fail-closed PER SOURCE: one source erroring is recorded and the run
 *    continues to the next, exactly as `syncSource` treats a per-file failure.
 *  - Idempotent + resumable: `syncSource` dedupes by sha256 and resumes by
 *    drive-item id, so pressing sync-all repeatedly never duplicates or
 *    double-counts.
 *  - Bounded per call: the orchestrator stops STARTING new sources once its
 *    wall-clock budget is spent and returns `moreRemaining: true`, so it lives
 *    within the route's maxDuration and is safe to press again to continue.
 *    A source already in progress is never interrupted mid-source.
 */

import { trackEvent } from "@/lib/analytics";
import { createRepo, type SharepointRepo } from "@/lib/connectors/sharepoint/repo";
import { syncSource, type SyncResult } from "@/lib/connectors/sharepoint/sync";
import type { SharepointSource, IngestJobStatus } from "@/lib/connectors/sharepoint/types";

/** Per-source outcome inside an estate sync. `"error"` is the orchestrator's own
 *  marker for a source whose sync threw before producing a job result. */
export interface EstateSourceOutcome {
  sourceId: string;
  name: string;
  estate: string;
  status: IngestJobStatus | "error";
  fileCount: number;
  successCount: number;
  failCount: number;
  error: string | null;
  moreRemaining: boolean;
}

/** Aggregate outcome of one estate-sync invocation. */
export interface EstateSyncResult {
  sourcesTotal: number;
  sourcesProcessed: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  filesIngested: number;
  sources: EstateSourceOutcome[];
  /** True when the budget ran out with sources still unprocessed, OR any
   *  processed source itself had more files to do. Press sync-all again. */
  moreRemaining: boolean;
}

export interface SyncAllOpts {
  /** Injectable repo (tests). */
  repo?: SharepointRepo;
  /** Injectable single-source sync (tests). Defaults to the real `syncSource`. */
  syncOne?: (
    source: SharepointSource,
    triggeredBy: string,
    triggeredByRole: string,
  ) => Promise<SyncResult>;
  /** Wall-clock budget for the whole call. Kept under the route's maxDuration so
   *  the orchestrator returns cleanly rather than being killed mid-source. */
  budgetMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Default budget: under the route's 300s maxDuration, with headroom to finish
 *  the source in flight and write the summary before the platform timeout. */
export const ESTATE_SYNC_BUDGET_MS = 250_000;

/**
 * Sync every active source for a workspace. Reuses `syncSource` per source.
 */
export async function syncAllSources(
  workspaceId: string,
  triggeredBy: string,
  triggeredByRole: string,
  opts: SyncAllOpts = {},
): Promise<EstateSyncResult> {
  const repo = opts.repo ?? createRepo();
  const syncOne = opts.syncOne ?? syncSource;
  const budgetMs = opts.budgetMs ?? ESTATE_SYNC_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  const sources = await repo.listSources(workspaceId); // active-only (repo filters)
  const outcomes: EstateSourceOutcome[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let filesIngested = 0;
  let budgetExhausted = false;

  for (const source of sources) {
    // Stop STARTING new sources once the budget is spent; the ones not started
    // are why moreRemaining is true. A source already begun is never cut off.
    if (now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }

    try {
      const r = await syncOne(source, triggeredBy, triggeredByRole);
      processed += 1;
      filesIngested += r.successCount;
      if (r.status === "failed") failed += 1;
      else succeeded += 1;
      outcomes.push({
        sourceId: source.id,
        name: source.name,
        estate: source.estate,
        status: r.status,
        fileCount: r.fileCount,
        successCount: r.successCount,
        failCount: r.failCount,
        error: r.error,
        moreRemaining: Boolean(r.moreRemaining),
      });
    } catch (err) {
      // Fail-closed per source: record and keep going. One bad source (an
      // expired token, a deleted site) must not strand the rest of the estate.
      processed += 1;
      failed += 1;
      outcomes.push({
        sourceId: source.id,
        name: source.name,
        estate: source.estate,
        status: "error",
        fileCount: 0,
        successCount: 0,
        failCount: 0,
        error: (err as Error)?.message ?? "unknown",
        moreRemaining: true,
      });
    }
  }

  const moreRemaining =
    budgetExhausted || outcomes.some((o) => o.moreRemaining);

  const result: EstateSyncResult = {
    sourcesTotal: sources.length,
    sourcesProcessed: processed,
    sourcesSucceeded: succeeded,
    sourcesFailed: failed,
    filesIngested,
    sources: outcomes,
    moreRemaining,
  };

  trackEvent(
    "connectors.sharepoint.estate_sync_finished",
    triggeredBy,
    triggeredByRole,
    {
      workspace_id: workspaceId,
      sources_total: result.sourcesTotal,
      sources_processed: result.sourcesProcessed,
      sources_succeeded: result.sourcesSucceeded,
      sources_failed: result.sourcesFailed,
      files_ingested: result.filesIngested,
      more_remaining: result.moreRemaining,
    },
  );

  return result;
}
