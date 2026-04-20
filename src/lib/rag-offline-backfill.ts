"use client";

/**
 * rag-offline-backfill — Ambient doc-body backfill for the RAG offline
 * cache (Path C — Stream U5 follow-up).
 *
 * Problem: U5 (rag-offline.ts) stores `sources: Array<{id, title?,
 * score?}>` on every cached RAG answer. If the user is offline and taps
 * a source chip, we have an ID and a title — no body. Blank page.
 *
 * Fix (this module): the moment a wrapper (`assistant-rag-offline`,
 * `brain-rag-offline`, `knowledge-rag-offline`) successfully caches a
 * fresh response, it calls `scheduleDocBodyBackfill(scope, sources)`.
 * We then, IN THE BACKGROUND — never blocking the caller, never
 * throwing — fetch the top-K source doc bodies from whatever endpoint
 * exists for that scope and stash them in the generic resource cache
 * under `resource_type="doc_body"`. A later UI that wants to render a
 * source card offline just calls `readCachedDocBody(id)`.
 *
 * Invariants:
 *   1. `scheduleDocBodyBackfill` is fire-and-forget. It returns
 *      synchronously (before the caller's microtask drain) and never
 *      throws. ANY exception bubbling out would break the wrapper call
 *      path that triggered it — unacceptable.
 *   2. Concurrency cap 3, GLOBAL. Ten simultaneous `schedule...` calls
 *      still see at most 3 in-flight fetches at any moment. The rest
 *      queue behind a tiny counting-semaphore.
 *   3. Dedup window `maxAgeMs` (default 24h). If the cache already has
 *      a fresh entry for that doc_id we skip the fetch entirely —
 *      zero-bandwidth no-op.
 *   4. Per-fetch timeout 10s. If the doc endpoint is stuck we skip and
 *      move on; the queue never stalls behind one slow response.
 *   5. All fetches go through `fetchWithRefresh` per CLAUDE.md.
 *
 * Endpoint discovery:
 *   - brain      → GET /api/brain/documents/[id]   (returns { document,
 *                   chunks }; we flatten chunks into a single content
 *                   string).
 *   - knowledge  → NO per-id GET endpoint exists today. Wrappers still
 *                   call scheduleDocBodyBackfill but we emit
 *                   `rag.doc_backfill_skipped { reason: "no_endpoint" }`
 *                   and bail. Ship /api/knowledge/[id] later and the
 *                   backfill will light up without any wrapper changes.
 *   - assistant  → the assistant answer cites docs that live in one of
 *                   the other scopes. When a caller has per-source
 *                   scope info it can thread it through; otherwise we
 *                   probe brain first (biggest doc corpus) then skip.
 *
 * Analytics (per CLAUDE.md — every feature feeds the learning loop):
 *   rag.doc_backfill_scheduled  { scope, source_count, top_k }
 *   rag.doc_backfilled          { scope, doc_id, bytes }
 *   rag.doc_backfill_skipped    { scope, doc_id, reason }
 *   rag.doc_backfill_completed  { scope, attempted, cached, skipped,
 *                                  failed, duration_ms }
 */

import {
  cacheResource,
  readCachedResource,
} from "@/lib/offline-cache";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RagScope = "assistant" | "brain" | "knowledge";

export interface DocBody {
  id: string;
  title?: string;
  /** Full text. For brain, chunks joined with "\n\n". */
  content: string;
  scope: "assistant" | "brain" | "knowledge";
  cached_at: number;
}

export interface BackfillSource {
  id: string;
  title?: string;
}

export interface BackfillOptions {
  /** How many of the incoming sources to attempt. Default 3. */
  topK?: number;
  /** Dedup window — skip if cache entry is newer than this. Default 24h. */
  maxAgeMs?: number;
  /** Progress callback exposed for tests / dashboards. */
  onProgress?: (done: number, total: number) => void;
  /** Test seam: inject analytics collector. */
  onAnalytics?: (event: string, metadata: AnalyticsMeta) => void;
  /** Test seam: override fetchWithRefresh. */
  fetcher?: typeof fetchWithRefresh;
  /** Test seam: override Date.now for deterministic cached_at. */
  now?: () => number;
  /** Test seam: override per-fetch timeout (ms). Default 10_000. */
  timeoutMs?: number;
  /** Test seam: override max concurrency. Default 3. */
  maxConcurrency?: number;
}

export interface BackfillSummary {
  attempted: number;
  cached: number;
  skipped: number;
  failed: number;
}

type AnalyticsMeta = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_BODY_RESOURCE_TYPE = "doc_body";
const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Global concurrency gate
// ---------------------------------------------------------------------------

/**
 * Tiny counting-semaphore. Across EVERY scheduled backfill (however
 * many wrappers fired), we hold at most `maxConcurrency` in-flight
 * fetches. The rest park on a FIFO waiter queue.
 *
 * We re-create the semaphore when the caller's requested concurrency
 * changes (default path — cap 3 — reuses the same instance so the cap
 * is truly global, not per-batch).
 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  public readonly capacity: number;
  public inFlight = 0;
  public peakInFlight = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      this.inFlight += 1;
      if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available = Math.min(this.capacity, this.available + 1);
    }
  }
}

let globalSemaphore: Semaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);

/** Test seam: reset the global semaphore (and peak counter). */
export function __resetBackfillForTests(
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
): void {
  globalSemaphore = new Semaphore(maxConcurrency);
}

/** Test helper: peek at the global semaphore's peak in-flight count. */
export function __getBackfillPeakInFlight(): number {
  return globalSemaphore.peakInFlight;
}

// ---------------------------------------------------------------------------
// Analytics (fire-and-forget, mirrors rag-offline.ts)
// ---------------------------------------------------------------------------

async function postAnalytics(
  event: string,
  metadata: AnalyticsMeta,
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

function defaultEmit(event: string, metadata: AnalyticsMeta): void {
  void postAnalytics(event, metadata);
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

interface EndpointConfig {
  /** Build the URL for a given doc id. null = no endpoint exists. */
  url: ((id: string) => string) | null;
  /** Parse the server payload into a content string. */
  parse: (payload: unknown) => string | null;
}

function endpointFor(scope: RagScope): EndpointConfig {
  switch (scope) {
    case "brain":
      // GET /api/brain/documents/[id] returns { document, chunks }.
      // Flatten chunks into one content string so the cached DocBody is
      // self-contained.
      return {
        url: (id) => `/api/brain/documents/${encodeURIComponent(id)}`,
        parse: (payload) => {
          if (!payload || typeof payload !== "object") return null;
          const p = payload as {
            document?: { content?: string };
            chunks?: Array<{ content?: string }>;
          };
          const fromChunks = Array.isArray(p.chunks)
            ? p.chunks
                .map((c) => (typeof c.content === "string" ? c.content : ""))
                .filter((s) => s.length > 0)
                .join("\n\n")
            : "";
          if (fromChunks.length > 0) return fromChunks;
          if (p.document && typeof p.document.content === "string") {
            return p.document.content;
          }
          return null;
        },
      };
    case "knowledge":
      // No per-id GET endpoint exists today. Graceful skip per spec.
      return { url: null, parse: () => null };
    case "assistant":
      // Assistant answers cite docs that live in other scopes; we can't
      // resolve a generic assistant doc URL. If a caller ever threads a
      // per-source scope through we could dispatch — for now, skip.
      return { url: null, parse: () => null };
  }
}

// ---------------------------------------------------------------------------
// Cache reader (public)
// ---------------------------------------------------------------------------

/**
 * Read a previously-backfilled doc body from the offline resource
 * cache. `scope` is optional — if omitted we return whatever doc body
 * is cached for that id regardless of which scope wrote it.
 */
export async function readCachedDocBody(
  id: string,
  scope?: RagScope,
): Promise<DocBody | null> {
  try {
    const resourceId = scope ? `${scope}::${id}` : id;
    // Fast path: scoped key.
    const scoped = await readCachedResource<DocBody>(
      DOC_BODY_RESOURCE_TYPE,
      resourceId,
      { silent: true },
    );
    if (scoped && isDocBody(scoped.data)) return scoped.data;

    // Fallback: legacy unscoped key (or scope omitted) — try every
    // scope prefix. Kept O(3) so it's negligible overhead.
    if (!scope) {
      for (const s of ["brain", "knowledge", "assistant"] as RagScope[]) {
        const hit = await readCachedResource<DocBody>(
          DOC_BODY_RESOURCE_TYPE,
          `${s}::${id}`,
          { silent: true },
        );
        if (hit && isDocBody(hit.data)) return hit.data;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isDocBody(v: unknown): v is DocBody {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.content === "string" &&
    typeof d.scope === "string" &&
    typeof d.cached_at === "number"
  );
}

// ---------------------------------------------------------------------------
// Fire-and-forget scheduler (public)
// ---------------------------------------------------------------------------

/**
 * Schedule a background doc-body backfill for the given sources. Never
 * throws. Never blocks the caller. Returns synchronously.
 *
 * Safe to call on every successful RAG wrapper response.
 */
export function scheduleDocBodyBackfill(
  scope: RagScope,
  sources: BackfillSource[],
  opts?: BackfillOptions,
): void {
  try {
    // Wrap the promise kick-off in a microtask so the caller's stack
    // unwinds fully before we touch IO. Guarantees non-blocking even
    // on implementations where `backfillDocBodies` might eagerly do
    // synchronous work before its first `await`.
    Promise.resolve()
      .then(() => backfillDocBodies(scope, sources, opts))
      .catch(() => {
        /* swallow — schedule is fire-and-forget */
      });
  } catch {
    /* must never throw — wrapper call paths depend on this */
  }
}

// ---------------------------------------------------------------------------
// Imperative backfill (public — primarily for tests, but also for
// "prepare for offline" flows if we ever ship that UI)
// ---------------------------------------------------------------------------

export async function backfillDocBodies(
  scope: RagScope,
  sources: BackfillSource[],
  opts?: BackfillOptions,
): Promise<BackfillSummary> {
  const emit = opts?.onAnalytics ?? defaultEmit;
  const topK = opts?.topK ?? DEFAULT_TOP_K;
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = opts?.fetcher ?? fetchWithRefresh;
  const now = opts?.now ?? Date.now;
  const onProgress = opts?.onProgress;

  if (
    opts?.maxConcurrency !== undefined &&
    opts.maxConcurrency !== globalSemaphore.capacity
  ) {
    // Caller asked for a different cap than the global default —
    // spin up a dedicated semaphore for this batch ONLY. We do not
    // mutate `globalSemaphore` because other in-flight schedules may
    // be depending on the default cap.
    return runWithSemaphore(
      new Semaphore(opts.maxConcurrency),
      scope,
      sources,
      { topK, maxAgeMs, timeoutMs, fetcher, now, onProgress, emit },
    );
  }

  return runWithSemaphore(globalSemaphore, scope, sources, {
    topK,
    maxAgeMs,
    timeoutMs,
    fetcher,
    now,
    onProgress,
    emit,
  });
}

interface RunParams {
  topK: number;
  maxAgeMs: number;
  timeoutMs: number;
  fetcher: typeof fetchWithRefresh;
  now: () => number;
  onProgress?: (done: number, total: number) => void;
  emit: (event: string, metadata: AnalyticsMeta) => void;
}

async function runWithSemaphore(
  sem: Semaphore,
  scope: RagScope,
  sources: BackfillSource[],
  params: RunParams,
): Promise<BackfillSummary> {
  const startedAt = params.now();
  const truncated = Array.isArray(sources) ? sources.slice(0, params.topK) : [];

  params.emit("rag.doc_backfill_scheduled", {
    scope,
    source_count: Array.isArray(sources) ? sources.length : 0,
    top_k: truncated.length,
  });

  const endpoint = endpointFor(scope);
  const summary: BackfillSummary = {
    attempted: truncated.length,
    cached: 0,
    skipped: 0,
    failed: 0,
  };

  if (endpoint.url === null) {
    // Graceful skip — emit one skipped event per source so the
    // learning loop has per-doc granularity.
    for (const src of truncated) {
      params.emit("rag.doc_backfill_skipped", {
        scope,
        doc_id: src.id,
        reason: "no_endpoint",
      });
      summary.skipped += 1;
    }
    emitCompleted(params, scope, summary, startedAt);
    return summary;
  }

  let done = 0;
  const tasks = truncated.map(async (src) => {
    await sem.acquire();
    try {
      const outcome = await backfillOne(
        scope,
        src,
        endpoint,
        params,
      );
      if (outcome === "cached") summary.cached += 1;
      else if (outcome === "failed") summary.failed += 1;
      else summary.skipped += 1;
    } finally {
      sem.release();
      done += 1;
      if (params.onProgress) {
        try {
          params.onProgress(done, truncated.length);
        } catch {
          /* isolate caller bugs */
        }
      }
    }
  });

  await Promise.all(tasks);

  emitCompleted(params, scope, summary, startedAt);
  return summary;
}

function emitCompleted(
  params: RunParams,
  scope: RagScope,
  summary: BackfillSummary,
  startedAt: number,
): void {
  params.emit("rag.doc_backfill_completed", {
    scope,
    attempted: summary.attempted,
    cached: summary.cached,
    skipped: summary.skipped,
    failed: summary.failed,
    duration_ms: params.now() - startedAt,
  });
}

type FetchOutcome = "cached" | "skipped" | "failed";

async function backfillOne(
  scope: RagScope,
  src: BackfillSource,
  endpoint: EndpointConfig,
  params: RunParams,
): Promise<FetchOutcome> {
  // Dedup gate — is there already a fresh cache entry?
  try {
    const existing = await readCachedResource<DocBody>(
      DOC_BODY_RESOURCE_TYPE,
      `${scope}::${src.id}`,
      { silent: true },
    );
    if (
      existing &&
      isDocBody(existing.data) &&
      params.now() - existing.data.cached_at < params.maxAgeMs
    ) {
      params.emit("rag.doc_backfill_skipped", {
        scope,
        doc_id: src.id,
        reason: "recent_cache_hit",
      });
      return "skipped";
    }
  } catch {
    // Treat cache read errors as "no existing entry" — fall through
    // to the fetch path.
  }

  if (endpoint.url === null) {
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "no_endpoint",
    });
    return "skipped";
  }

  const url = endpoint.url(src.id);

  let response: Response | null = null;
  let timedOut = false;
  try {
    response = await withTimeout(
      () => params.fetcher(url, { method: "GET" }),
      params.timeoutMs,
      () => {
        timedOut = true;
      },
    );
  } catch {
    if (timedOut) {
      params.emit("rag.doc_backfill_skipped", {
        scope,
        doc_id: src.id,
        reason: "timeout",
      });
      return "skipped";
    }
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "fetch_failed",
    });
    return "failed";
  }

  if (!response || !response.ok) {
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "fetch_failed",
    });
    return "failed";
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "fetch_failed",
    });
    return "failed";
  }

  const content = endpoint.parse(payload);
  if (!content || content.length === 0) {
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "fetch_failed",
    });
    return "failed";
  }

  const body: DocBody = {
    id: src.id,
    title: src.title,
    content,
    scope,
    cached_at: params.now(),
  };

  try {
    await cacheResource(DOC_BODY_RESOURCE_TYPE, `${scope}::${src.id}`, body);
  } catch {
    params.emit("rag.doc_backfill_skipped", {
      scope,
      doc_id: src.id,
      reason: "fetch_failed",
    });
    return "failed";
  }

  params.emit("rag.doc_backfilled", {
    scope,
    doc_id: src.id,
    bytes: content.length,
  });
  return "cached";
}

/**
 * Race `fn()` against a timeout. On timeout we invoke `onTimeout` so
 * the caller can set a boolean flag, then reject so the caller branches
 * into the skipped-timeout path. We do NOT attempt to abort the
 * underlying fetch — fetchWithRefresh doesn't expose the AbortSignal
 * through our call sites — but the race ensures the queue moves on.
 */
function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new Error("backfill fetch timeout"));
    }, ms);

    fn().then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
