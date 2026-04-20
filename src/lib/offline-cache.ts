"use client";

/**
 * Generic offline resource cache for Instinct (Path C — platform-wide
 * offline pattern, Stream U4).
 *
 * Generalizes `offline-brief-cache` from a site-only primitive into a
 * resource-agnostic store. ANY feature (sites, meetings, HR docs,
 * journals, discussions, knowledge captures) can now stash a server
 * snapshot and read it back during an offline cold-load with one call.
 *
 * IndexedDB schema:
 *   db   = "instinct-resource-cache"   (sibling DB to "instinct-offline",
 *                                       kept separate so we can evolve the
 *                                       generic-cache schema without racing
 *                                       offline-queue.ts / offline-brief-cache.ts
 *                                       onupgradeneeded handlers)
 *   store = "resource_cache"
 *   keyPath = "id"   (composite "<resource_type>::<resource_id>")
 *   index  = "by_type" on resource_type (non-unique)
 *   record = {
 *     id,            // composite key — "meeting_draft::abc-123"
 *     resource_type, // "brief", "meeting_draft", "hr_doc_pending", ...
 *     resource_id,   // stable string id per resource instance
 *     data,          // arbitrary JSON
 *     fetched_at,    // ms epoch
 *   }
 *
 * Why a composite key + index instead of one store per resource type?
 * Object-store creation requires a DB version bump. A single store with
 * an index lets new resource types land without migrations.
 *
 * Analytics:
 *   offline.resource_served_from_cache { resource_type, resource_id, cache_age_ms }
 *
 * Graceful degradation: if IndexedDB is unavailable (Safari private,
 * iframe) we fall back to an in-memory Map. The app still works online;
 * offline cold-loads just lose the fallback.
 */

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types (mirror the contract in docs/offline-pattern.md)
// ---------------------------------------------------------------------------

export interface ResourceCacheEntry<T = unknown> {
  resource_type: string;
  resource_id: string;
  data: T;
  fetched_at: number;
}

/** Internal row — same as ResourceCacheEntry plus the composite key. */
interface StoredRow<T = unknown> extends ResourceCacheEntry<T> {
  id: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = "instinct-resource-cache";
const DB_VERSION = 1;
const STORE_RESOURCE = "resource_cache";
const INDEX_BY_TYPE = "by_type";

export function composeKey(resourceType: string, resourceId: string): string {
  return `${resourceType}::${resourceId}`;
}

// ---------------------------------------------------------------------------
// IDB helpers — sibling DB to `instinct-offline`. Kept separate so this
// module can evolve its schema independently of offline-queue /
// offline-brief-cache.
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;
const memoryCache = new Map<string, StoredRow>();
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
      if (!db.objectStoreNames.contains(STORE_RESOURCE)) {
        const store = db.createObjectStore(STORE_RESOURCE, { keyPath: "id" });
        store.createIndex(INDEX_BY_TYPE, "resource_type", { unique: false });
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
        const tx = db.transaction(STORE_RESOURCE, mode);
        const s = tx.objectStore(STORE_RESOURCE);
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

function defaultEmit(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  void postAnalytics(event, metadata);
}

// ---------------------------------------------------------------------------
// Public API — write
// ---------------------------------------------------------------------------

export async function cacheResource<T>(
  resourceType: string,
  resourceId: string,
  data: T,
): Promise<void> {
  const row: StoredRow<T> = {
    id: composeKey(resourceType, resourceId),
    resource_type: resourceType,
    resource_id: resourceId,
    data,
    fetched_at: Date.now(),
  };

  if (!idbAvailable()) usingMemoryFallback = true;

  if (usingMemoryFallback) {
    memoryCache.set(row.id, row as StoredRow);
    return;
  }

  try {
    await withStore("readwrite", (s) =>
      s.put(row) as IDBRequest<IDBValidKey>,
    );
  } catch {
    usingMemoryFallback = true;
    memoryCache.set(row.id, row as StoredRow);
  }
}

// ---------------------------------------------------------------------------
// Public API — read
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /** Skip analytics emission (internal / test). */
  silent?: boolean;
  /** Analytics hook override for tests. */
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
  /**
   * When true, ALSO emits the legacy `offline.brief_served_from_cache`
   * event (only meaningful when resource_type === "brief"). Used by
   * `offline-brief-cache.ts` for backward compat.
   */
  emitLegacyBriefEvent?: boolean;
}

export async function readCachedResource<T>(
  resourceType: string,
  resourceId: string,
  opts?: ReadOptions,
): Promise<ResourceCacheEntry<T> | null> {
  const key = composeKey(resourceType, resourceId);
  let row: StoredRow<T> | null = null;

  if (usingMemoryFallback) {
    row = (memoryCache.get(key) as StoredRow<T> | undefined) ?? null;
  } else {
    try {
      const raw = await withStore<StoredRow<T> | undefined>(
        "readonly",
        (s) => s.get(key) as IDBRequest<StoredRow<T> | undefined>,
      );
      row = raw ?? null;
    } catch {
      row = (memoryCache.get(key) as StoredRow<T> | undefined) ?? null;
    }
  }

  if (row && !opts?.silent) {
    const cacheAge = Date.now() - row.fetched_at;
    const emit = opts?.onAnalytics ?? defaultEmit;
    emit("offline.resource_served_from_cache", {
      resource_type: resourceType,
      resource_id: resourceId,
      cache_age_ms: cacheAge,
    });
    // Backward-compat: also fire the legacy site-specific event when the
    // caller is the brief cache. Keeps existing dashboards green.
    if (opts?.emitLegacyBriefEvent && resourceType === "brief") {
      emit("offline.brief_served_from_cache", {
        site_id: resourceId,
        cache_age_ms: cacheAge,
      });
    }
  }

  if (!row) return null;
  return {
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    data: row.data,
    fetched_at: row.fetched_at,
  };
}

// ---------------------------------------------------------------------------
// Public API — delete / list
// ---------------------------------------------------------------------------

export async function clearResource(
  resourceType: string,
  resourceId: string,
): Promise<void> {
  const key = composeKey(resourceType, resourceId);
  if (usingMemoryFallback) {
    memoryCache.delete(key);
    return;
  }
  try {
    await withStore("readwrite", (s) =>
      s.delete(key) as IDBRequest<undefined>,
    );
  } catch {
    memoryCache.delete(key);
  }
}

/** List every cached entry for a resource_type. Sorted newest-first. */
export async function listCachedResources(
  resourceType: string,
): Promise<ResourceCacheEntry<unknown>[]> {
  // Memory-fallback path.
  if (usingMemoryFallback) {
    return Array.from(memoryCache.values())
      .filter((r) => r.resource_type === resourceType)
      .sort((a, b) => b.fetched_at - a.fetched_at)
      .map(({ id: _id, ...rest }) => rest);
  }

  try {
    const rows = await openDb().then(
      (db) =>
        new Promise<StoredRow[]>((resolve, reject) => {
          const tx = db.transaction(STORE_RESOURCE, "readonly");
          const idx = tx.objectStore(STORE_RESOURCE).index(INDEX_BY_TYPE);
          const req = idx.getAll(IDBKeyRange.only(resourceType)) as IDBRequest<
            StoredRow[]
          >;
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        }),
    );
    return rows
      .sort((a, b) => b.fetched_at - a.fetched_at)
      .map(({ id: _id, ...rest }) => rest);
  } catch {
    return Array.from(memoryCache.values())
      .filter((r) => r.resource_type === resourceType)
      .sort((a, b) => b.fetched_at - a.fetched_at)
      .map(({ id: _id, ...rest }) => rest);
  }
}

/** Wipe EVERY cached resource regardless of type (logout). */
export async function clearAllResources(): Promise<void> {
  memoryCache.clear();
  if (!idbAvailable()) return;
  try {
    await withStore("readwrite", (s) =>
      s.clear() as IDBRequest<undefined>,
    );
  } catch {
    /* ignore */
  }
}

/** Cache age in ms (no analytics). */
export async function getResourceAgeMs(
  resourceType: string,
  resourceId: string,
): Promise<number | null> {
  const rec = await readCachedResource(resourceType, resourceId, {
    silent: true,
  });
  return rec ? Date.now() - rec.fetched_at : null;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export function __resetForTests(): void {
  dbPromise = null;
  usingMemoryFallback = false;
  memoryCache.clear();
}
