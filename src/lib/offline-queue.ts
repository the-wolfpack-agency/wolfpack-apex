"use client";

/**
 * Offline mutation queue for Instinct (Path C — site editor offline mode).
 *
 * When a POST / PATCH / PUT / DELETE fires while the user is offline, we
 * enqueue it in IndexedDB (object store `mutation_queue`, keyPath `id`).
 * When `online` fires we drain the queue sequentially in FIFO order,
 * re-attaching a freshly-read Bearer token at replay time.
 *
 * Design rules (see wolfpack-apex CLAUDE.md):
 *   - Zero new runtime dependencies — native IDB.
 *   - NEVER persist the Authorization header. The JWT TTL is 15 min; a
 *     queued payload may sit for hours. Re-read from localStorage at
 *     replay time via `authHeaders()`.
 *   - Retry with exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s).
 *     After 5 attempts give up and mark the entry as `failed` so the
 *     OfflineStatusPill can surface it for manual retry.
 *   - Analytics fire for every state transition so the learning loop
 *     sees offline usage patterns (endpoint × success ÷ failure rate).
 *   - Safari private / ITP fallback: if IndexedDB is unavailable the
 *     queue degrades to in-memory only (data loss on refresh, but the
 *     app does not crash).
 *
 * Tested in src/lib/__tests__/offline-queue.test.ts via fake-indexeddb.
 */

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MutationMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface QueuedMutation {
  id: string;
  endpoint: string;
  method: MutationMethod;
  /** Headers minus Authorization — we re-add on replay from current session. */
  headers: Record<string, string>;
  /** JSON-serialized body (null for bodyless methods). */
  body: string | null;
  enqueued_at: number;
  attempts: number;
  last_error: string | null;
  /** "pending" = awaiting drain. "failed" = gave up after MAX_ATTEMPTS. */
  status: "pending" | "failed";
}

export interface ReplayResult {
  replayed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = "instinct-offline";
const DB_VERSION = 1;
const STORE_QUEUE = "mutation_queue";
export const STORE_BRIEF = "brief_cache";

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const BACKOFF_CAP_MS = 30000;

// Strip auth / cookie headers that depend on session state. Everything else
// (Content-Type, X-* custom headers) is replay-safe.
const SESSION_HEADER_DENYLIST = new Set([
  "authorization",
  "cookie",
  "x-csrf-token",
]);

// ---------------------------------------------------------------------------
// IDB open / store helpers
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

/** In-memory fallback when IDB is unavailable (Safari private, iframes). */
const memoryQueue: QueuedMutation[] = [];
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

async function withStore<T>(
  mode: IDBTransactionMode,
  store: string,
  fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const objStore = tx.objectStore(store);
    try {
      const result = fn(objStore);
      if (result instanceof Promise) {
        result.then(resolve, reject);
        return;
      }
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    } catch (err) {
      reject(err);
    }
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Analytics (fire-and-forget, never throws)
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
// UUID — tiny crypto-based impl (avoid uuid runtime dep in client bundle)
// ---------------------------------------------------------------------------

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback — 16 bytes of Math.random is fine for idempotency IDs.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Header stripping
// ---------------------------------------------------------------------------

/**
 * Return a copy of `headers` without session-bound entries (Authorization,
 * Cookie, CSRF). Export so tests can assert the invariant directly.
 */
export function stripSessionHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const h = new Headers(headers);
  h.forEach((value, key) => {
    if (!SESSION_HEADER_DENYLIST.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Public API — enqueue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  endpoint: string;
  method: MutationMethod;
  headers?: HeadersInit;
  body?: unknown;
}

export async function enqueueMutation(input: EnqueueInput): Promise<QueuedMutation> {
  const entry: QueuedMutation = {
    id: uuid(),
    endpoint: input.endpoint,
    method: input.method,
    headers: stripSessionHeaders(input.headers),
    body:
      input.body === undefined || input.body === null
        ? null
        : typeof input.body === "string"
          ? input.body
          : JSON.stringify(input.body),
    enqueued_at: Date.now(),
    attempts: 0,
    last_error: null,
    status: "pending",
  };

  try {
    await withStore("readwrite", STORE_QUEUE, (s) => s.add(entry));
  } catch {
    usingMemoryFallback = true;
    memoryQueue.push(entry);
  }

  void postAnalytics("offline.mutation_queued", {
    endpoint: entry.endpoint,
    method: entry.method,
  });

  return entry;
}

// ---------------------------------------------------------------------------
// Public API — list
// ---------------------------------------------------------------------------

export async function listQueue(): Promise<QueuedMutation[]> {
  if (usingMemoryFallback) {
    return [...memoryQueue].sort((a, b) => a.enqueued_at - b.enqueued_at);
  }
  try {
    const rows = await withStore<QueuedMutation[]>(
      "readonly",
      STORE_QUEUE,
      (s) => s.getAll() as IDBRequest<QueuedMutation[]>,
    );
    return rows.sort((a, b) => a.enqueued_at - b.enqueued_at);
  } catch {
    return [...memoryQueue].sort((a, b) => a.enqueued_at - b.enqueued_at);
  }
}

export async function queueSize(): Promise<number> {
  const rows = await listQueue();
  return rows.filter((r) => r.status === "pending").length;
}

// ---------------------------------------------------------------------------
// Public API — clear (testing + "clear failed" button)
// ---------------------------------------------------------------------------

export async function deleteEntry(id: string): Promise<void> {
  if (usingMemoryFallback) {
    const idx = memoryQueue.findIndex((e) => e.id === id);
    if (idx >= 0) memoryQueue.splice(idx, 1);
    return;
  }
  try {
    await withStore("readwrite", STORE_QUEUE, (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export async function clearQueue(): Promise<void> {
  memoryQueue.length = 0;
  if (!idbAvailable()) return;
  try {
    await withStore("readwrite", STORE_QUEUE, (s) => s.clear());
  } catch {
    /* ignore */
  }
}

async function updateEntry(entry: QueuedMutation): Promise<void> {
  if (usingMemoryFallback) {
    const idx = memoryQueue.findIndex((e) => e.id === entry.id);
    if (idx >= 0) memoryQueue[idx] = entry;
    return;
  }
  try {
    await withStore("readwrite", STORE_QUEUE, (s) => s.put(entry));
  } catch {
    const idx = memoryQueue.findIndex((e) => e.id === entry.id);
    if (idx >= 0) memoryQueue[idx] = entry;
    else memoryQueue.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export function backoffForAttempt(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1);
  return Math.min(BACKOFF_MS[idx], BACKOFF_CAP_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export type FetchFn = typeof fetch;

export interface FlushOptions {
  /** Override fetch (tests inject a mock). Defaults to global fetch. */
  fetchImpl?: FetchFn;
  /**
   * Sleep implementation — tests pass a no-op so exponential backoff
   * doesn't actually wait. Defaults to real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Token provider — tests inject a fixed token. Defaults to
   * `getInstinctToken()` from client-auth.
   */
  tokenProvider?: () => string | null;
  /** Fire analytics via this hook (test override). */
  onAnalytics?: (event: string, metadata: Record<string, string | number | boolean>) => void;
}

async function replayOne(
  entry: QueuedMutation,
  opts: Required<Pick<FlushOptions, "fetchImpl" | "sleep" | "tokenProvider" | "onAnalytics">>,
): Promise<{ ok: boolean; error?: string }> {
  const token = opts.tokenProvider();
  const headers = new Headers(entry.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (entry.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await opts.fetchImpl(entry.endpoint, {
      method: entry.method,
      headers,
      body: entry.body ?? undefined,
      credentials: "include",
    });
    if (res.ok) return { ok: true };
    // 4xx / 5xx — record and let the caller decide whether to retry.
    // We treat 401 as "auth expired, retry" and 4xx non-auth as "terminal".
    if (res.status === 401) return { ok: false, error: "auth_401" };
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, error: `http_${res.status}_terminal` };
    }
    return { ok: false, error: `http_${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "network_error" };
  }
}

/**
 * Drain the queue sequentially. Returns a summary. Does not throw.
 *
 * Behavior:
 *   - FIFO order (by enqueued_at).
 *   - On success: delete entry, fire offline.mutation_replayed.
 *   - On transient failure: increment attempts, sleep backoffForAttempt,
 *     retry inline up to MAX_ATTEMPTS. After MAX: mark `failed`,
 *     fire offline.mutation_replay_failed, move on.
 *   - On terminal 4xx (non-401): mark `failed` immediately — retrying a
 *     400 won't help.
 *   - Emits offline.returned_online once at the top of the flush.
 */
export async function flushQueue(options: FlushOptions = {}): Promise<ReplayResult> {
  const opts = {
    fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    sleep: options.sleep ?? delay,
    tokenProvider: options.tokenProvider ?? getInstinctToken,
    onAnalytics:
      options.onAnalytics ??
      ((event, metadata) => {
        void postAnalytics(event, metadata);
      }),
  };

  const entries = (await listQueue()).filter((e) => e.status === "pending");
  if (entries.length === 0) return { replayed: 0, failed: 0 };

  opts.onAnalytics("offline.returned_online", { queue_size: entries.length });

  let replayed = 0;
  let failed = 0;

  for (const entry of entries) {
    let success = false;
    let lastError = "";

    while (entry.attempts < MAX_ATTEMPTS) {
      const attempt = entry.attempts;
      const result = await replayOne(entry, opts);
      entry.attempts = attempt + 1;
      if (result.ok) {
        success = true;
        break;
      }
      lastError = result.error ?? "unknown";
      entry.last_error = lastError;
      await updateEntry(entry);

      // Terminal 4xx (other than 401) — no retry.
      if (lastError.endsWith("_terminal")) break;

      opts.onAnalytics("offline.mutation_replay_failed", {
        endpoint: entry.endpoint,
        error: lastError,
        attempt: entry.attempts,
      });

      if (entry.attempts >= MAX_ATTEMPTS) break;
      await opts.sleep(backoffForAttempt(entry.attempts - 1));
    }

    if (success) {
      replayed++;
      opts.onAnalytics("offline.mutation_replayed", {
        endpoint: entry.endpoint,
        success: true,
      });
      await deleteEntry(entry.id);
    } else {
      failed++;
      entry.status = "failed";
      entry.last_error = lastError || "max_attempts_exceeded";
      await updateEntry(entry);
      opts.onAnalytics("offline.mutation_replay_failed", {
        endpoint: entry.endpoint,
        error: entry.last_error,
        attempt: entry.attempts,
      });
    }
  }

  return { replayed, failed };
}

// ---------------------------------------------------------------------------
// Test seam — reset module state between tests
// ---------------------------------------------------------------------------

export function __resetForTests(): void {
  dbPromise = null;
  usingMemoryFallback = false;
  memoryQueue.length = 0;
}
