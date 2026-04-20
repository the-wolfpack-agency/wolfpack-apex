"use client";

/**
 * useOfflineCache — React hook wrapping `src/lib/offline-cache.ts`.
 *
 * Semantics:
 *   1. On mount, attempt fetcher().
 *      - Success → cacheResource(resource_type, resource_id, data) +
 *        return { data, isStale: false, cacheAgeMs: 0, isLoading: false }.
 *      - Failure → readCachedResource(...) + return
 *        { data: cached?.data ?? null, isStale: true,
 *          cacheAgeMs: now - cached.fetched_at, isLoading: false }.
 *   2. On `online` event, if currently stale, auto-refetch.
 *   3. `refetch()` manually kicks the fetcher.
 *
 * Analytics fired by this hook:
 *   - None directly. The underlying `readCachedResource` fires
 *     `offline.resource_served_from_cache { resource_type, resource_id,
 *     cache_age_ms }` on cache hit, which is what dashboards slice by.
 *
 * Important: pass a STABLE fetcher (useCallback) or the hook will
 * re-run on every render. The effect depends on `fetcher` identity.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cacheResource,
  readCachedResource,
} from "@/lib/offline-cache";

export interface UseOfflineCacheResult<T> {
  data: T | null;
  isLoading: boolean;
  isStale: boolean;
  cacheAgeMs: number | null;
  refetch: () => Promise<void>;
}

export function useOfflineCache<T>(
  resourceType: string,
  resourceId: string,
  fetcher: () => Promise<T>,
): UseOfflineCacheResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStale, setIsStale] = useState(false);
  const [cacheAgeMs, setCacheAgeMs] = useState<number | null>(null);

  // Keep the latest fetcher in a ref so the effect is stable even if the
  // caller forgets useCallback. We still read the latest version at call
  // time.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const loadOnce = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const fresh = await fetcherRef.current();
      setData(fresh);
      setIsStale(false);
      setCacheAgeMs(0);
      // Fire-and-forget cache write — never block the render path on IDB.
      void cacheResource(resourceType, resourceId, fresh);
    } catch {
      const cached = await readCachedResource<T>(resourceType, resourceId);
      if (cached) {
        setData(cached.data);
        setIsStale(true);
        setCacheAgeMs(Date.now() - cached.fetched_at);
      } else {
        setData(null);
        setIsStale(false);
        setCacheAgeMs(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [resourceType, resourceId]);

  const refetch = useCallback(async (): Promise<void> => {
    await loadOnce();
  }, [loadOnce]);

  // Mount + resource_id change → reload.
  useEffect(() => {
    void loadOnce();
  }, [loadOnce]);

  // On returning online, if currently stale, try again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => {
      if (isStale) {
        void loadOnce();
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [isStale, loadOnce]);

  return { data, isLoading, isStale, cacheAgeMs, refetch };
}
