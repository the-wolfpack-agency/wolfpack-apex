/**
 * Resolver — orchestrates "read cache, refresh if stale, fall back on
 * Graph failure." The page + API + TimeLogWidget all call through here
 * so the staleness policy lives in one place.
 *
 * Cache freshness policy:
 *   - SUCCESS window: 15 min (configurable via JOB_CODES_TTL_MS).
 *     Within that, return the cache without touching Graph.
 *   - STALE window: cache > TTL → trigger a refresh BEFORE returning.
 *     If the refresh succeeds, return the fresh rows. If it fails,
 *     return the stale cache and log a `served_stale` refresh row so
 *     the UI can surface "X minutes since last sync, Graph unreachable."
 *   - COLD (cache empty): forces a refresh. If that fails, return an
 *     error to the caller — there's no fallback content.
 *
 * No data lost: every refresh outcome (success / stale / failure)
 * lands a row in instinct_job_codes_refresh and fires a typed
 * analytics event so the learning loop can see Graph reliability.
 */

import { trackEvent } from "@/lib/analytics";
import { fetchJobCodesFromSharePoint } from "./sharepoint-source";
import {
  getSourceInfo,
  listActiveJobCodes,
  recordRefreshOutcome,
  replaceJobCodes,
} from "./repo";
import type {
  JobCode,
  JobCodesError,
  JobCodesRefreshOutcome,
  JobCodesRefreshSource,
  JobCodesSourceInfo,
  Result,
} from "./types";

const TTL_MS = Number(process.env.JOB_CODES_TTL_MS ?? 15 * 60 * 1000);

export interface ResolveOptions {
  /** Force a Graph refresh even if cache is fresh. */
  forceRefresh?: boolean;
  /** What kind of trigger this refresh is (drives the refresh log
   *  source column). Defaults to "auto_stale". */
  refreshSource?: JobCodesRefreshSource;
  /** Instinct user id for the refresh log. Null for system/scheduled. */
  triggeredBy?: string | null;
}

export interface ResolveResult {
  rows: JobCode[];
  source: JobCodesSourceInfo;
  /** True if Graph was just called this request (vs pure cache read). */
  refreshed: boolean;
  /** Whether the response is from a stale cache (Graph failed). */
  servedStale: boolean;
  /** Most recent refresh outcome if we ran one — null on cache hit. */
  refreshOutcome: JobCodesRefreshOutcome | null;
}

function isFresh(lastRefreshedAt: string | null): boolean {
  if (!lastRefreshedAt) return false;
  const age = Date.now() - new Date(lastRefreshedAt).getTime();
  return age < TTL_MS;
}

/**
 * Run a refresh end-to-end. Returns the outcome regardless of success
 * so callers can decide whether to fall back to cache.
 */
export async function refreshFromSource(
  opts: { source: JobCodesRefreshSource; triggeredBy: string | null; hint?: { driveId: string; itemId: string } },
): Promise<JobCodesRefreshOutcome> {
  const startedAt = new Date().toISOString();

  /* Pass the triggering user id so the source tries their delegated
     token first. Falls back to the app-only token if delegated lookup
     fails (background/scheduled refresh case). */
  const res = await fetchJobCodesFromSharePoint({
    hint: opts.hint,
    preferUserId: opts.triggeredBy,
  });
  if (!res.ok) {
    const outcome: JobCodesRefreshOutcome = {
      status: "failed",
      source: opts.source,
      rowsSeen: 0,
      rowsAdded: 0,
      rowsUpdated: 0,
      rowsDeactivated: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: res.error,
    };
    /* Best-effort write — repo failure here would mask the original
       Graph error. We swallow log errors so the typed result remains
       the source of truth. */
    await recordRefreshOutcome(outcome, opts.triggeredBy).catch(() => null);
    try {
      await trackEvent("jobcodes.refresh_failed", opts.triggeredBy ?? "system", "system", {
        reason: res.error.code,
        detail: res.error.detail.slice(0, 200),
        source: opts.source,
      });
    } catch { /* analytics best-effort */ }
    return outcome;
  }

  const diff = await replaceJobCodes(res.value.rows, {
    driveId: res.value.driveId,
    itemId: res.value.itemId,
    webUrl: res.value.webUrl,
  });

  const outcome: JobCodesRefreshOutcome = {
    status: "succeeded",
    source: opts.source,
    rowsSeen: res.value.rows.length,
    rowsAdded: diff.added,
    rowsUpdated: diff.updated,
    rowsDeactivated: diff.deactivated,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await recordRefreshOutcome(outcome, opts.triggeredBy).catch(() => null);
  try {
    await trackEvent("jobcodes.refresh_succeeded", opts.triggeredBy ?? "system", "system", {
      rows_seen: res.value.rows.length,
      rows_added: diff.added,
      rows_updated: diff.updated,
      rows_deactivated: diff.deactivated,
      source: opts.source,
      sheet_name: res.value.sheetName,
    });
  } catch { /* analytics best-effort */ }
  return outcome;
}

/**
 * Resolve the current set of job codes — the primary read entrypoint
 * for the page, the API, and the TimeLogWidget.
 */
export async function resolveJobCodes(
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const sourceInfo = await getSourceInfo();
  const cacheRows = await listActiveJobCodes();

  const cacheCold = cacheRows.length === 0;
  const cacheStale = !isFresh(sourceInfo.lastRefreshedAt);
  const shouldRefresh = opts.forceRefresh || cacheCold || cacheStale;

  if (!shouldRefresh) {
    return {
      rows: cacheRows,
      source: sourceInfo,
      refreshed: false,
      servedStale: false,
      refreshOutcome: null,
    };
  }

  const hint =
    sourceInfo.driveId && sourceInfo.itemId
      ? { driveId: sourceInfo.driveId, itemId: sourceInfo.itemId }
      : undefined;

  const outcome = await refreshFromSource({
    source: opts.refreshSource ?? "auto_stale",
    triggeredBy: opts.triggeredBy ?? null,
    hint,
  });

  if (outcome.status === "succeeded") {
    const freshRows = await listActiveJobCodes();
    const freshSource = await getSourceInfo();
    return {
      rows: freshRows,
      source: freshSource,
      refreshed: true,
      servedStale: false,
      refreshOutcome: outcome,
    };
  }

  /* Refresh failed. If we have any cache rows, serve them as stale
     (and log a separate served_stale row so dashboards can distinguish
     "refresh failed" from "refresh failed AND user got nothing"). */
  if (cacheRows.length > 0) {
    await recordRefreshOutcome(
      {
        ...outcome,
        status: "served_stale",
        finishedAt: new Date().toISOString(),
      },
      opts.triggeredBy ?? null,
    ).catch(() => null);
    try {
      await trackEvent("jobcodes.served_stale", opts.triggeredBy ?? "system", "system", {
        reason: outcome.error?.code ?? "unknown",
        cache_row_count: cacheRows.length,
      });
    } catch { /* analytics best-effort */ }
    return {
      rows: cacheRows,
      source: sourceInfo,
      refreshed: true,
      servedStale: true,
      refreshOutcome: outcome,
    };
  }

  /* Cold-cache failure — caller must surface the error. */
  return {
    rows: [],
    source: sourceInfo,
    refreshed: true,
    servedStale: false,
    refreshOutcome: outcome,
  };
}

/** Exposed for the refresh API route + admin "Refresh now" button. */
export async function forceRefresh(
  triggeredBy: string,
  source: JobCodesRefreshSource = "manual",
): Promise<JobCodesRefreshOutcome> {
  const sourceInfo = await getSourceInfo();
  const hint =
    sourceInfo.driveId && sourceInfo.itemId
      ? { driveId: sourceInfo.driveId, itemId: sourceInfo.itemId }
      : undefined;
  return refreshFromSource({ source, triggeredBy, hint });
}

/** Public re-exports for callers that want the freshness/error types
 *  without reaching into ./types. */
export type {
  JobCode,
  JobCodesError,
  JobCodesSourceInfo,
  JobCodesRefreshOutcome,
  Result,
};
