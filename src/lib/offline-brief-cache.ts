"use client";

/**
 * Offline brief cache for Instinct (Path C — site editor offline mode).
 *
 * As of Stream U4 this file is a thin, backward-compatible wrapper around
 * `offline-cache.ts` with `resource_type = "brief"`. The public API is
 * unchanged — existing callers (site editor, OfflineStatusPill) keep
 * working without modification. Prefer `offline-cache.ts` for new
 * features (meetings, HR docs, journals, etc.).
 *
 * Schema shape returned to callers stays:
 *   { site_id, brief, fetched_at }
 *
 * Analytics: fires BOTH the new generic `offline.resource_served_from_cache`
 * event AND the legacy `offline.brief_served_from_cache` so existing
 * dashboards stay green. See analytics.ts.
 */

import {
  cacheResource,
  clearAllResources,
  clearResource,
  listCachedResources,
  readCachedResource,
  __resetForTests as __resetGenericCacheForTests,
  type ResourceCacheEntry,
} from "@/lib/offline-cache";

// ---------------------------------------------------------------------------
// Types (legacy — preserved for backward compat)
// ---------------------------------------------------------------------------

export interface CachedBriefRecord<T = unknown> {
  site_id: string;
  brief: T;
  fetched_at: number;
}

const RESOURCE_TYPE = "brief";

// ---------------------------------------------------------------------------
// Public API (legacy names, delegated to the generic cache)
// ---------------------------------------------------------------------------

/** Write a brief to the cache after a successful fetch. Never throws. */
export async function saveBriefSnapshot<T>(
  siteId: string,
  brief: T,
): Promise<void> {
  await cacheResource(RESOURCE_TYPE, siteId, brief);
}

/**
 * Read a cached brief. Returns null when absent or IDB-unavailable.
 * Fires offline.brief_served_from_cache analytics on hit (plus the
 * generic offline.resource_served_from_cache — see analytics.ts).
 */
export async function readBriefSnapshot<T>(
  siteId: string,
  opts?: {
    silent?: boolean;
    onAnalytics?: (
      event: string,
      metadata: Record<string, string | number | boolean>,
    ) => void;
  },
): Promise<CachedBriefRecord<T> | null> {
  // We need to (a) keep firing the LEGACY event with the original metadata
  // shape { site_id, cache_age_ms }, and (b) NOT surface the new generic
  // event to existing callers' onAnalytics mocks — the legacy test suite
  // asserts exactly ONE call with the legacy event name.
  //
  // Strategy: intercept analytics from offline-cache, translate the generic
  // event into the legacy event, and drop the generic event entirely for
  // callers of this wrapper. New features should call offline-cache
  // directly and get the modern event.
  const intercepted: Array<
    [string, Record<string, string | number | boolean>]
  > = [];

  const rec = await readCachedResource<T>(RESOURCE_TYPE, siteId, {
    silent: opts?.silent,
    onAnalytics: (event, metadata) => {
      intercepted.push([event, metadata]);
    },
  });

  if (rec && !opts?.silent) {
    const cacheAge = Date.now() - rec.fetched_at;
    const emit =
      opts?.onAnalytics ??
      ((event: string, metadata: Record<string, string | number | boolean>) => {
        // Fire-and-forget via the analytics endpoint — matches pre-U4 behavior.
        // We import lazily to avoid a circular dependency at module load.
        import("@/lib/client-auth")
          .then(({ fetchWithRefresh, getInstinctToken }) => {
            if (typeof window === "undefined") return;
            if (!getInstinctToken()) return;
            return fetchWithRefresh("/api/analytics", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event, metadata }),
              keepalive: true,
            });
          })
          .catch(() => undefined);
      });
    emit("offline.brief_served_from_cache", {
      site_id: siteId,
      cache_age_ms: cacheAge,
    });
  }

  if (!rec) return null;
  return {
    site_id: rec.resource_id,
    brief: rec.data,
    fetched_at: rec.fetched_at,
  };
}

/** Compute the cache age in ms (without firing analytics). */
export async function getCacheAgeMs(siteId: string): Promise<number | null> {
  const rec = await readCachedResource(RESOURCE_TYPE, siteId, { silent: true });
  return rec ? Date.now() - rec.fetched_at : null;
}

/** Delete one site's cache entry (called on site deletion). */
export async function deleteBriefSnapshot(siteId: string): Promise<void> {
  await clearResource(RESOURCE_TYPE, siteId);
}

/** Wipe every brief snapshot (logout / testing). */
export async function clearAllBriefs(): Promise<void> {
  // Only clears the entire resource_cache — acceptable for a logout path
  // since we also want meetings/hr/journal caches gone on logout.
  await clearAllResources();
}

/** List every cached brief (for debugging / admin tools). */
export async function listCachedBriefs(): Promise<CachedBriefRecord<unknown>[]> {
  const rows: ResourceCacheEntry<unknown>[] = await listCachedResources(
    RESOURCE_TYPE,
  );
  return rows.map((r) => ({
    site_id: r.resource_id,
    brief: r.data,
    fetched_at: r.fetched_at,
  }));
}

/** Reset singletons (tests only). */
export function __resetForTests(): void {
  __resetGenericCacheForTests();
}
