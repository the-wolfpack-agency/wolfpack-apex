"use client";

/**
 * Brain Pack client store — IDB-backed cache of `{id, doc_id, title,
 * text, embedding}` rows that Level-2 offline search runs against.
 *
 * Stream U3. Companion pieces:
 *   - brain-pack-sync.ts      — progressive downloader (writer)
 *   - brain-ann.ts            — consumer of getCachedChunks() (reader)
 *   - src/app/api/brain/pack  — server producer
 *
 * Kept in its OWN IndexedDB (sibling to `instinct-offline` and
 * `instinct-resource-cache`) so pack-store schema can evolve without
 * racing the other two stores' onupgradeneeded handlers. Same pattern
 * as src/lib/offline-cache.ts.
 *
 * IDB schema:
 *   db    = "instinct-brain-pack"
 *   store = "chunks"
 *     keyPath = "id"
 *     index "by_workspace" on "workspace" (non-unique)
 *     record = {
 *       id, doc_id, title, text, embedding: number[], workspace,
 *       cached_at: ms_epoch
 *     }
 *
 * Graceful degradation:
 *   - No IndexedDB (Safari private mode, iframe): in-memory Map. The
 *     tab still works; next cold-load loses the cache.
 *   - QuotaExceededError on put: bubble up to the sync layer so it can
 *     fire `brain.pack_sync_skipped { reason: "quota_exceeded" }` and
 *     the caller can UI-prompt or invoke clearPack().
 *
 * Never-proactive: this module does NOT fetch from the network. The
 * syncer (brain-pack-sync.ts) is the only writer from the network, and
 * brain-ann.ts is the only reader in the critical path.
 */

// ---------------------------------------------------------------------------
// Public contract (matches the contract U4 depends on).
// ---------------------------------------------------------------------------

export interface CachedChunk {
  id: string;
  doc_id: string;
  title: string;
  text: string;
  embedding: number[];
  workspace: string;
  cached_at: number;
}

export interface PackStats {
  chunk_count: number;
  total_bytes: number;
  oldest_cached_at: number | null;
  newest_cached_at: number | null;
}

// ---------------------------------------------------------------------------
// Internals — IDB open + per-op transaction helpers.
// ---------------------------------------------------------------------------

const DB_NAME = "instinct-brain-pack";
const DB_VERSION = 1;
const STORE = "chunks";
const INDEX_BY_WORKSPACE = "by_workspace";

let dbPromise: Promise<IDBDatabase> | null = null;
const memoryCache = new Map<string, CachedChunk>();
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
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex(INDEX_BY_WORKSPACE, "workspace", { unique: false });
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
        const tx = db.transaction(STORE, mode);
        const s = tx.objectStore(STORE);
        const req = fn(s);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function estimateBytes(c: CachedChunk): number {
  // Rough — JSON size dominates for our tier. Embedding is the heavy
  // slice (~6 KiB / 1536 floats). text is usually < 2 KiB.
  return (
    c.id.length +
    c.doc_id.length +
    c.title.length +
    c.text.length * 2 + // UTF-16 worst case
    c.embedding.length * 8
  );
}

// ---------------------------------------------------------------------------
// Public reader API — what brain-ann.ts + UI badges call.
// ---------------------------------------------------------------------------

/**
 * Load every cached chunk for a workspace. Returns empty array when the
 * pack hasn't been synced yet. Ordered by cached_at ascending so the
 * oldest (= most-trusted) chunks surface first to ANN.
 */
export async function getCachedChunks(
  workspace: string,
): Promise<CachedChunk[]> {
  if (!workspace) return [];
  if (usingMemoryFallback) return readWorkspaceFromMemory(workspace);

  try {
    const rows = await openDb().then(
      (db) =>
        new Promise<CachedChunk[]>((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const idx = tx.objectStore(STORE).index(INDEX_BY_WORKSPACE);
          const out: CachedChunk[] = [];
          const req = idx.openCursor(IDBKeyRange.only(workspace));
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) {
              resolve(out.sort((a, b) => a.cached_at - b.cached_at));
              return;
            }
            out.push(cur.value as CachedChunk);
            cur.continue();
          };
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        }),
    );
    return rows;
  } catch {
    return readWorkspaceFromMemory(workspace);
  }
}

/**
 * Lookup a single chunk by id (workspace-agnostic — `id` is unique across
 * workspaces per server generation). Used by the brain UI to resolve a
 * chunk id surfaced through a search hit without paging the whole pack.
 */
export async function getCachedChunkById(
  id: string,
): Promise<CachedChunk | null> {
  if (!id) return null;
  if (usingMemoryFallback) return memoryCache.get(id) ?? null;
  try {
    const row = await withStore<CachedChunk | undefined>(
      "readonly",
      (s) => s.get(id) as IDBRequest<CachedChunk | undefined>,
    );
    return row ?? null;
  } catch {
    return memoryCache.get(id) ?? null;
  }
}

/**
 * Summary stats for UI ("Brain Pack: 142 chunks / 1.2 MB cached") and
 * for the syncer to decide whether a QuotaExceededError is imminent.
 */
export async function getPackStats(workspace: string): Promise<PackStats> {
  const chunks = await getCachedChunks(workspace);
  if (chunks.length === 0) {
    return {
      chunk_count: 0,
      total_bytes: 0,
      oldest_cached_at: null,
      newest_cached_at: null,
    };
  }
  let total = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const c of chunks) {
    total += estimateBytes(c);
    if (c.cached_at < oldest) oldest = c.cached_at;
    if (c.cached_at > newest) newest = c.cached_at;
  }
  return {
    chunk_count: chunks.length,
    total_bytes: total,
    oldest_cached_at: oldest === Number.POSITIVE_INFINITY ? null : oldest,
    newest_cached_at: newest || null,
  };
}

// ---------------------------------------------------------------------------
// Public writer API — only brain-pack-sync.ts + tests should call these.
// ---------------------------------------------------------------------------

/** Thrown when IDB reports QuotaExceeded. The syncer converts to a
 *  `brain.pack_sync_skipped { reason: "quota_exceeded" }` analytics
 *  event and stops the current page. */
export class PackQuotaExceededError extends Error {
  constructor(message = "IndexedDB quota exceeded for brain pack") {
    super(message);
    this.name = "PackQuotaExceededError";
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22
  );
}

/**
 * Write one page of chunks atomically. Used by brain-pack-sync.ts after
 * each /api/brain/pack page response. Throws PackQuotaExceededError on
 * quota pressure so the syncer can skip the remainder of the sync.
 */
export async function putCachedChunks(
  chunks: CachedChunk[],
): Promise<{ written: number; skipped: number }> {
  if (chunks.length === 0) return { written: 0, skipped: 0 };

  if (!idbAvailable()) usingMemoryFallback = true;

  if (usingMemoryFallback) {
    for (const c of chunks) memoryCache.set(c.id, c);
    return { written: chunks.length, skipped: 0 };
  }

  try {
    await openDb().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const s = tx.objectStore(STORE);
          for (const c of chunks) {
            try {
              s.put(c);
            } catch (err) {
              if (isQuotaError(err)) {
                reject(new PackQuotaExceededError());
                return;
              }
              reject(err);
              return;
            }
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => {
            if (isQuotaError(tx.error)) {
              reject(new PackQuotaExceededError());
            } else {
              reject(tx.error);
            }
          };
          tx.onabort = () => {
            if (isQuotaError(tx.error)) {
              reject(new PackQuotaExceededError());
            } else {
              reject(tx.error ?? new Error("transaction aborted"));
            }
          };
        }),
    );
    return { written: chunks.length, skipped: 0 };
  } catch (err) {
    if (err instanceof PackQuotaExceededError) throw err;
    // Non-quota IDB failure — fall back to memory so the tab still has
    // something to search against until next sync.
    usingMemoryFallback = true;
    for (const c of chunks) memoryCache.set(c.id, c);
    return { written: chunks.length, skipped: 0 };
  }
}

/**
 * Clear every cached chunk for a workspace. Invoked on sign-out, when
 * the user explicitly taps "Clear offline pack", or when the syncer
 * resets a corrupted pack.
 */
export async function clearPack(workspace: string): Promise<void> {
  if (!workspace) return;

  if (usingMemoryFallback) {
    for (const [k, v] of memoryCache) {
      if (v.workspace === workspace) memoryCache.delete(k);
    }
    return;
  }

  try {
    await openDb().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const idx = tx.objectStore(STORE).index(INDEX_BY_WORKSPACE);
          const req = idx.openCursor(IDBKeyRange.only(workspace));
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            cur.delete();
            cur.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  } catch {
    // fall back to memory wipe for the workspace
    for (const [k, v] of memoryCache) {
      if (v.workspace === workspace) memoryCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers — not public API.
// ---------------------------------------------------------------------------

/** @internal — reset module-level singletons for Jest isolation. */
export function __resetBrainPackStoreForTests(): void {
  dbPromise = null;
  memoryCache.clear();
  usingMemoryFallback = false;
}

/** @internal — force the memory fallback path (for syncer tests that
 *  run in jsdom without fake-indexeddb). */
export function __forceMemoryFallbackForTests(): void {
  usingMemoryFallback = true;
}

function readWorkspaceFromMemory(workspace: string): CachedChunk[] {
  const out: CachedChunk[] = [];
  for (const v of memoryCache.values()) {
    if (v.workspace === workspace) out.push(v);
  }
  return out.sort((a, b) => a.cached_at - b.cached_at);
}
