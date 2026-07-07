/**
 * Resolver — the single place the staleness policy lives for a tracker:
 *   FRESH  (snapshot < TTL)          -> return cache, no Graph call.
 *   STALE/COLD/forced                -> refresh from Graph, then return fresh.
 *   Refresh fails but a snapshot exists -> serve the stale snapshot + flag.
 *   Refresh fails and cache is cold  -> empty, with the error code.
 *
 * No data lost: every attempt updates the cache's last_attempt_* columns AND
 * fires a typed analytics event (invoice_tracker.refreshed / .refresh_failed),
 * which triple-writes into the learning spine. NEVER throws — a finance page
 * must not blank on a transient Graph error.
 */
import { getSnapshot, saveSnapshot, recordAttempt } from "./repo";
import { fetchSheet } from "./sharepoint-source";
import { shareUrlFor, type InvoiceTracker } from "./config";
import { trackEvent } from "@/lib/analytics";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ResolveResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  source: "cache" | "fresh" | "stale" | "empty";
  lastRefreshedAt: string | null;
  refreshed: boolean;
  servedStale: boolean;
  errorCode?: string;
  webUrl: string | null;
}

export async function resolveTracker(args: {
  tracker: InvoiceTracker;
  triggeredBy: string;
  triggeredByRole?: string;
  forceRefresh?: boolean;
}): Promise<ResolveResult> {
  const { tracker, triggeredBy } = args;
  const role = args.triggeredByRole ?? "unknown";
  const snap = await getSnapshot(tracker.id);
  const now = Date.now();
  const fresh = snap?.lastRefreshedAt ? now - Date.parse(snap.lastRefreshedAt) < TTL_MS : false;

  if (snap && fresh && !args.forceRefresh) {
    return {
      columns: snap.columns,
      rows: snap.rows,
      source: "cache",
      lastRefreshedAt: snap.lastRefreshedAt,
      refreshed: false,
      servedStale: false,
      webUrl: snap.webUrl,
    };
  }

  const fetched = await fetchSheet({
    shareUrl: shareUrlFor(tracker),
    sheetName: tracker.sheet,
    preferUserId: triggeredBy,
    forwardFill: tracker.forwardFill,
  });

  if (fetched.ok) {
    await saveSnapshot({
      trackerId: tracker.id,
      columns: fetched.value.columns,
      rows: fetched.value.rows,
      driveId: fetched.value.driveId,
      itemId: fetched.value.itemId,
      webUrl: fetched.value.webUrl,
      sheetName: fetched.value.sheetName,
    });
    trackEvent("invoice_tracker.refreshed", triggeredBy, role, {
      tracker: tracker.id,
      rows: fetched.value.rows.length,
      columns: fetched.value.columns.length,
      token_kind: fetched.value.tokenKind,
    });
    return {
      columns: fetched.value.columns,
      rows: fetched.value.rows,
      source: "fresh",
      lastRefreshedAt: new Date(now).toISOString(),
      refreshed: true,
      servedStale: false,
      webUrl: fetched.value.webUrl,
    };
  }

  // Refresh failed. Record the attempt, but keep serving the last good snapshot.
  await recordAttempt(tracker.id, snap ? "served_stale" : "failed", fetched.error.detail).catch(() => {});
  trackEvent("invoice_tracker.refresh_failed", triggeredBy, role, {
    tracker: tracker.id,
    error_code: fetched.error.code,
    served_stale: Boolean(snap),
  });

  if (snap) {
    return {
      columns: snap.columns,
      rows: snap.rows,
      source: "stale",
      lastRefreshedAt: snap.lastRefreshedAt,
      refreshed: false,
      servedStale: true,
      errorCode: fetched.error.code,
      webUrl: snap.webUrl,
    };
  }
  return {
    columns: [],
    rows: [],
    source: "empty",
    lastRefreshedAt: null,
    refreshed: false,
    servedStale: false,
    errorCode: fetched.error.code,
    webUrl: null,
  };
}
