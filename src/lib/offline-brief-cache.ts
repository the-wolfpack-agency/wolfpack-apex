"use client";

/**
 * Offline brief cache for Instinct (Path C — site editor offline mode).
 *
 * Stores a snapshot of the most recently successful GET /api/sites/:id
 * response so that a cold-load in an offline window can still render
 * the site editor against the last-saved brief.
 *
 * IndexedDB schema:
 *   db   = "instinct-offline"
 *   store = "brief_cache"
 *   keyPath = "site_id"
 *   record = { site_id, brief, fetched_at (ms epoch) }
 *
 * Analytics:
 *   offline.brief_served_from_cache { site_id, cache_age_ms }
 *
 * Graceful degradation: if IndexedDB is unavailable (Safari private /
 * iframe), we fall back to an in-memory Map. The app keeps working
 * online; offline cold-load just won't have a fallback to show.
 */

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedBriefRecord<T = unknown> {
  site_id: string;
  brief: T;
  fetched_at: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = "instinct-offline";
const DB_VERSION = 1;
const STORE_BRIEF = "brief_cache";
const STORE_QUEUE = "mutation_queue";

// ---------------------------------------------------------------------------
// IDB helpers (mirrors offline-queue — single DB, single version)
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;
const memoryCache = new Map<string, CachedBriefRecord>();
let usingMemoryFallback = false;

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (!idbAvailable()) {
    usingMemoryFallback = true;
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BRIEF)) {
        db.createObjectStore(STORE_BRIEF, { keyPath: "site_id" });
      }
    };
    req.onerror = () => {
      usingMemoryFallback = true;
      reject(req.error ?? new Error("IndexedDB open failed"));
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_BRIEF, mode);
        const s = tx.objectStore(STORE_BRIEF);
        const req = fn(s);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

// ---------------------------------------------------------------------------
// Analytics (fire-and-forget)
// ---------------------------------------------------------------------------

async function postAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (typeof window === "undefined") return;
  const token = getInstinctToken();
  if (!token) return;
  try {
    await fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, metadata }),
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write a brief to the cache after a successful fetch. Never throws. */
export async function saveBriefSnapshot<T>(
  siteId: string,
  brief: T,
): Promise<void> {
  const record: CachedBriefRecord<T> = {
    site_id: siteId,
    brief,
    fetched_at: Date.now(),
  };

  if (!idbAvailable()) {
    usingMemoryFallback = true;
  }

  if (usingMemoryFallback) {
    memoryCache.set(siteId, record as CachedBriefRecord);
    return;
  }
  try {
    await withStore("readwrite", (s) => s.put(record) as IDBRequest<unknown> as IDBRequest<IDBValidKey>);
  } catch {
    usingMemoryFallback = true;
    memoryCache.set(siteId, record as CachedBriefRecord);
  }
}

/**
 * Read a cached brief. Returns null when absent or IDB-unavailable.
 * Fires offline.brief_served_from_cache analytics on hit.
 */
export async function readBriefSnapshot<T>(
  siteId: string,
  opts?: {
    /** Skip analytics emission (internal / test). */
    silent?: boolean;
    /** Analytics hook override for tests. */
    onAnalytics?: (
      event: string,
      metadata: Record<string, string | number | boolean>,
    ) => void;
  },
): Promise<CachedBriefRecord<T> | null> {
  let record: CachedBriefRecord<T> | null = null;

  if (usingMemoryFallback) {
    record = (memoryCache.get(siteId) as CachedBriefRecord<T> | undefined) ?? null;
  } else {
    try {
      const raw = await withStore<CachedBriefRecord<T> | undefined>(
        "readonly",
        (s) => s.get(siteId) as IDBRequest<CachedBriefRecord<T> | undefined>,
      );
      record = raw ?? null;
    } catch {
      record = (memoryCache.get(siteId) as CachedBriefRecord<T> | undefined) ?? null;
    }
  }

  if (record && !opts?.silent) {
    const cacheAge = Date.now() - record.fetched_at;
    const emit =
      opts?.onAnalytics ??
      ((event: string, metadata: Record<string, string | number | boolean>) => {
        void postAnalytics(event, metadata);
      });
    emit("offline.brief_served_from_cache", {
      site_id: siteId,
      cache_age_ms: cacheAge,
    });
  }

  return record;
}

/** Compute the cache age in ms (without firing analytics). */
export async function getCacheAgeMs(siteId: string): Promise<number | null> {
  const rec = await readBriefSnapshot(siteId, { silent: true });
  return rec ? Date.now() - rec.fetched_at : null;
}

/** Delete one site's cache entry (called on site deletion). */
export async function deleteBriefSnapshot(siteId: string): Promise<void> {
  if (usingMemoryFallback) {
    memoryCache.delete(siteId);
    return;
  }
  try {
    await withStore("readwrite", (s) => s.delete(siteId) as IDBRequest<undefined>);
  } catch {
    memoryCache.delete(siteId);
  }
}

/** Wipe everything (logout / testing). */
export async function clearAllBriefs(): Promise<void> {
  memoryCache.clear();
  if (!idbAvailable()) return;
  try {
    await withStore("readwrite", (s) => s.clear() as IDBRequest<undefined>);
  } catch {
    /* ignore */
  }
}

/** Reset singletons (tests only). */
export function __resetForTests(): void {
  dbPromise = null;
  usingMemoryFallback = false;
  memoryCache.clear();
}
