"use client";

/**
 * ambient-refresh — User-invisible RAG cache freshness orchestrator
 * (Path C — Stream U6).
 *
 * Sits on top of U1's `rag-offline.ts` primitive and U2's three wrappers
 * (`assistant-rag-offline.ts`, `knowledge-rag-offline.ts`,
 * `brain-rag-offline.ts`). Provides two silent refresh mechanisms so the
 * RAG cache stays fresh without ANY user-visible controls:
 *
 *   1. `runSessionWarmPass()` — Called once per dashboard mount (see
 *      `useAmbientRefresh`). Walks the top N most-recent cached queries
 *      in each scope and re-issues them with `forceRefresh: true`.
 *      Rate-limited to 1 refresh per 2s so it never competes with
 *      user-initiated traffic. At 10 entries per scope * 3 scopes = 30
 *      refreshes * 2s = ~60s total wall time (non-blocking, low prio).
 *
 *   2. `startIdleRefresh()` — Kicks off an idle watcher. After 30s of
 *      no user input (click / key / scroll / touch / mousemove) AND
 *      `navigator.onLine`, picks the stalest cache entry (cached_at
 *      older than 24h) across all scopes and re-fetches it silently.
 *      Continues every 30s of idle, up to 5 refreshes per idle session,
 *      until all stale entries are fresh or the user returns.
 *
 * Design rules — STRICT:
 *   - Never throws. All fetch errors swallowed; a misbehaving wrapper
 *     MUST NOT crash the dashboard.
 *   - Never surfaces UI. No toasts, no banners, no console noise.
 *   - Never more than 1 refresh in-flight at once (global mutex).
 *   - Respects `navigator.connection.saveData` — if the user has Data
 *     Saver on, idle refresh is DISABLED entirely.
 *   - AbortSignal-aware so `useAmbientRefresh` unmount cleanly cancels
 *     any in-flight pass without leaking timers.
 *
 * Analytics (per CLAUDE.md — every feature feeds the learning loop):
 *   ambient.warm_pass_started         { scope_count }
 *   ambient.warm_pass_completed       { scope, attempted, refreshed, failed, duration_ms }
 *   ambient.idle_detected             { idle_ms }
 *   ambient.idle_refresh_fired        { scope, cache_age_ms_before, cache_age_ms_after }
 *   ambient.idle_refresh_skipped      { reason }  // "offline" | "save_data"
 *                                                // | "no_stale_entries"
 *                                                // | "max_refreshes_reached"
 *
 * This module is UI-primitive-level. Stream U1 owns rag-offline +
 * wrappers; this module only RE-CALLS those wrappers via their public
 * `forceRefresh: true` option. Do NOT import server-only modules here.
 */

import { listCachedRagResults, type CachedRagResult } from "@/lib/rag-offline";
import { queryAssistantWithCache } from "@/lib/assistant-rag-offline";
import { queryKnowledgeWithCache } from "@/lib/knowledge-rag-offline";
import { queryBrainWithCache } from "@/lib/brain-rag-offline";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type AmbientScope = "assistant" | "knowledge" | "brain";

type AnalyticsMeta = Record<string, string | number | boolean>;
type AnalyticsEmitter = (event: string, metadata: AnalyticsMeta) => void;

export interface SessionWarmPassOptions {
  /** Top N most-recent entries per scope. Default 10. */
  topN?: number;
  /**
   * Minimum delay between refreshes in ms. Default 2000 (2s).
   * At 10 entries * 3 scopes = 30 refreshes * 2s = ~60s wall time.
   */
  perRequestDelayMs?: number;
  /** Test seam — abort mid-pass cancels remaining refreshes. */
  signal?: AbortSignal;
  /** Test seam — analytics emitter override. */
  onAnalytics?: AnalyticsEmitter;
  /**
   * Test seam — override the wrapper fns so unit tests don't have to
   * stub fetchWithRefresh globally. Each wrapper is invoked with
   * `(query, { forceRefresh: true })` for a force-refresh re-query.
   */
  wrappers?: Partial<Record<AmbientScope, (query: string) => Promise<unknown>>>;
  /** Test seam — override listCachedRagResults. */
  lister?: (scope: string) => Promise<CachedRagResult<unknown>[]>;
}

export interface SessionWarmPassResult {
  scope: AmbientScope;
  attempted: number;
  refreshed: number;
  failed: number;
}

export interface IdleRefreshOptions {
  /** Idle threshold in ms. Default 30000 (30s). */
  idleThresholdMs?: number;
  /**
   * Entries with `cached_at` older than this are candidates for idle
   * refresh. Default 86_400_000 (24h).
   */
  staleThresholdMs?: number;
  /** Max refreshes per contiguous idle session. Default 5. */
  maxRefreshesPerIdleSession?: number;
  /** Test seam — abort cancels the whole watcher. */
  signal?: AbortSignal;
  /** Test seam — analytics emitter override. */
  onAnalytics?: AnalyticsEmitter;
  /** Test seam — override the wrapper fns. */
  wrappers?: Partial<Record<AmbientScope, (query: string) => Promise<unknown>>>;
  /** Test seam — override listCachedRagResults. */
  lister?: (scope: string) => Promise<CachedRagResult<unknown>[]>;
  /** Test seam — override navigator.onLine probe. */
  isOnline?: () => boolean;
  /** Test seam — override saveData probe. */
  isSaveData?: () => boolean;
}

export interface IdleRefreshHandle {
  stop: () => void;
}

const DEFAULT_TOP_N = 10;
const DEFAULT_PER_REQUEST_DELAY_MS = 2000;
const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_IDLE_REFRESHES = 5;

const AMBIENT_SCOPES: AmbientScope[] = ["assistant", "knowledge", "brain"];

const IDLE_EVENTS: ReadonlyArray<keyof DocumentEventMap> = [
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
];

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget, mirrors rag-offline.ts / offline-cache.ts.
// We default to POST /api/analytics but tests inject `onAnalytics`.
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
// Online / saveData probes — pure functions, safe in SSR (fall back to
// "online, no data saver" when window/navigator are missing).
// ---------------------------------------------------------------------------

function probeOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

interface NetworkConnectionLike {
  saveData?: boolean;
}

function probeSaveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (
    navigator as Navigator & { connection?: NetworkConnectionLike }
  ).connection;
  return Boolean(conn?.saveData);
}

// ---------------------------------------------------------------------------
// Default wrapper dispatch — invoked per-query with forceRefresh=true.
// The wrappers already swallow network errors internally; we additionally
// wrap in try/catch for RagOfflineMissError (offline mid-refresh).
// ---------------------------------------------------------------------------

function defaultWrappers(): Record<
  AmbientScope,
  (query: string) => Promise<unknown>
> {
  return {
    assistant: (query: string) =>
      queryAssistantWithCache(query, { forceRefresh: true }),
    knowledge: (query: string) =>
      queryKnowledgeWithCache(query, { forceRefresh: true }),
    brain: (query: string) =>
      queryBrainWithCache(query, { forceRefresh: true }),
  };
}

// ---------------------------------------------------------------------------
// Global in-flight mutex — at most 1 refresh active at a time. Prevents
// warm-pass + idle-refresh from racing when a warm pass is still running
// but the user has already been idle for 30s.
// ---------------------------------------------------------------------------

let refreshInFlight = false;

async function withRefreshLock<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  if (refreshInFlight) return fallback;
  refreshInFlight = true;
  try {
    return await fn();
  } finally {
    refreshInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Abortable sleep — resolves after ms OR when signal aborts.
// ---------------------------------------------------------------------------

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, ms);
    function onAbort() {
      clearTimeout(timer);
      cleanup();
    }
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort);
  });
}

// ---------------------------------------------------------------------------
// Session warm pass
// ---------------------------------------------------------------------------

/**
 * One-shot re-touch of the top N most-recent cached queries per scope.
 *
 * Silent: never throws, never surfaces UI. Rate-limited at 1 refresh per
 * `perRequestDelayMs` (default 2s) so it blends into the background and
 * never competes with user-initiated traffic.
 *
 * Aborts mid-pass if `opts.signal` fires — the remaining refreshes are
 * skipped. Returns the per-scope attempt counts even on abort so tests
 * can assert early-stop behavior.
 */
export async function runSessionWarmPass(
  opts: SessionWarmPassOptions = {},
): Promise<SessionWarmPassResult[]> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const perRequestDelayMs =
    opts.perRequestDelayMs ?? DEFAULT_PER_REQUEST_DELAY_MS;
  const emit = opts.onAnalytics ?? defaultEmit;
  const wrappers = { ...defaultWrappers(), ...(opts.wrappers ?? {}) };
  const lister = opts.lister ?? listCachedRagResults;
  const signal = opts.signal;

  emit("ambient.warm_pass_started", { scope_count: AMBIENT_SCOPES.length });

  const results: SessionWarmPassResult[] = [];

  let firstRequest = true;
  for (const scope of AMBIENT_SCOPES) {
    if (signal?.aborted) {
      // Emit a completed event with zero counts so the learning loop
      // still sees the scope was attempted (and aborted).
      results.push({ scope, attempted: 0, refreshed: 0, failed: 0 });
      emit("ambient.warm_pass_completed", {
        scope,
        attempted: 0,
        refreshed: 0,
        failed: 0,
        duration_ms: 0,
      });
      continue;
    }

    const scopeStarted = Date.now();
    let entries: CachedRagResult<unknown>[];
    try {
      entries = await lister(scope);
    } catch {
      entries = [];
    }
    // Newest-first (listCachedRagResults preserves this) — take top N.
    const top = entries.slice(0, topN);

    let attempted = 0;
    let refreshed = 0;
    let failed = 0;
    const wrapper = wrappers[scope];

    for (const entry of top) {
      if (signal?.aborted) break;
      // Rate-limit: hold off the per-request delay BEFORE every call
      // except the very first of the whole pass — that way the pass
      // starts promptly but still respects the ceiling across scopes.
      if (!firstRequest) {
        await abortableSleep(perRequestDelayMs, signal);
        if (signal?.aborted) break;
      }
      firstRequest = false;
      attempted += 1;

      const ok = await withRefreshLock(async () => {
        try {
          if (!wrapper) return false;
          await wrapper(entry.query);
          return true;
        } catch {
          // Wrapper raised — e.g. RagOfflineMissError if the tab went
          // offline mid-pass. Silently count as failed and continue.
          return false;
        }
      }, false);
      if (ok) refreshed += 1;
      else failed += 1;
    }

    const duration_ms = Date.now() - scopeStarted;
    results.push({ scope, attempted, refreshed, failed });
    emit("ambient.warm_pass_completed", {
      scope,
      attempted,
      refreshed,
      failed,
      duration_ms,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stalest-entry search — exported for tests only (`_findStalestEntry`).
// ---------------------------------------------------------------------------

/**
 * Scan every scope, return the entry with the oldest `cached_at` that
 * exceeds `staleThresholdMs`. Null when nothing is stale enough.
 *
 * Exported for test visibility; stable name prefixed with `_` to
 * signal "internal, may change".
 */
export async function _findStalestEntry(
  scopes: string[],
  staleThresholdMs: number,
  lister: (scope: string) => Promise<CachedRagResult<unknown>[]> = listCachedRagResults,
  now: number = Date.now(),
): Promise<{ scope: string; query: string; cached_at: number } | null> {
  let best: { scope: string; query: string; cached_at: number } | null = null;
  for (const scope of scopes) {
    let entries: CachedRagResult<unknown>[];
    try {
      entries = await lister(scope);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const age = now - entry.cached_at;
      if (age < staleThresholdMs) continue;
      if (best === null || entry.cached_at < best.cached_at) {
        best = {
          scope,
          query: entry.query,
          cached_at: entry.cached_at,
        };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Idle refresh watcher
// ---------------------------------------------------------------------------

/**
 * Starts the idle-refresh watcher. Returns a `stop()` fn for cleanup.
 *
 * Behaviour:
 *   - Listens to mousemove/keydown/scroll/touchstart/click on document.
 *   - Any event resets the idle timer.
 *   - After `idleThresholdMs` of quiet (default 30s), emits
 *     `ambient.idle_detected` and fires ONE refresh on the stalest
 *     entry (if any) — up to `maxRefreshesPerIdleSession` refreshes
 *     per contiguous idle session (default 5).
 *   - Pauses when `document.visibilityState === "hidden"` and resumes
 *     when visible. A full idle timer restart happens on resume so
 *     backgrounded tabs don't immediately fire on refocus.
 *   - Honors the Data Saver preference: if `navigator.connection.saveData`
 *     is `true`, the watcher is effectively disabled — it emits
 *     `ambient.idle_refresh_skipped { reason: "save_data" }` once and
 *     does not install any listeners.
 *   - Respects `opts.signal` — abort stops all timers + listeners.
 */
export function startIdleRefresh(
  opts: IdleRefreshOptions = {},
): IdleRefreshHandle {
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const maxRefreshes =
    opts.maxRefreshesPerIdleSession ?? DEFAULT_MAX_IDLE_REFRESHES;
  const emit = opts.onAnalytics ?? defaultEmit;
  const wrappers = { ...defaultWrappers(), ...(opts.wrappers ?? {}) };
  const lister = opts.lister ?? listCachedRagResults;
  const isOnline = opts.isOnline ?? probeOnline;
  const isSaveData = opts.isSaveData ?? probeSaveData;
  const signal = opts.signal;

  // SSR or Data-Saver path — disabled outright.
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { stop: () => {} };
  }
  if (isSaveData()) {
    emit("ambient.idle_refresh_skipped", { reason: "save_data" });
    return { stop: () => {} };
  }

  let idleStartMs = Date.now();
  let refreshesThisSession = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (stopped) return;
    if (document.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      void onIdleTick();
    }, idleThresholdMs);
  }

  function resetIdle() {
    // User activity — count any remaining idle session as over. Full
    // reset: we're no longer idle, and the next idle session gets its
    // own max-refresh budget.
    idleStartMs = Date.now();
    refreshesThisSession = 0;
    scheduleNext();
  }

  async function onIdleTick() {
    if (stopped) return;
    if (document.visibilityState === "hidden") return;

    const idleMs = Date.now() - idleStartMs;
    emit("ambient.idle_detected", { idle_ms: idleMs });

    if (refreshesThisSession >= maxRefreshes) {
      emit("ambient.idle_refresh_skipped", {
        reason: "max_refreshes_reached",
      });
      // Don't reschedule — we're done until the user returns.
      return;
    }
    if (!isOnline()) {
      emit("ambient.idle_refresh_skipped", { reason: "offline" });
      scheduleNext();
      return;
    }

    const stalest = await _findStalestEntry(
      AMBIENT_SCOPES,
      staleThresholdMs,
      lister,
    );
    if (!stalest) {
      emit("ambient.idle_refresh_skipped", { reason: "no_stale_entries" });
      scheduleNext();
      return;
    }

    const cacheAgeBefore = Date.now() - stalest.cached_at;
    const wrapper = wrappers[stalest.scope as AmbientScope];
    if (!wrapper) {
      // Unknown scope — shouldn't happen, but skip safely.
      scheduleNext();
      return;
    }

    let ok = false;
    await withRefreshLock(async () => {
      try {
        await wrapper(stalest.query);
        ok = true;
      } catch {
        ok = false;
      }
    }, undefined);

    if (ok) {
      refreshesThisSession += 1;
      // cached_at should now be ~Date.now(). We don't re-read the cache
      // to avoid a second IDB round-trip; the fresh value is effectively
      // 0 ms old from the wrapper's perspective.
      emit("ambient.idle_refresh_fired", {
        scope: stalest.scope,
        cache_age_ms_before: cacheAgeBefore,
        cache_age_ms_after: 0,
      });
    }
    scheduleNext();
  }

  function onActivity() {
    resetIdle();
  }

  function onVisibility() {
    if (stopped) return;
    if (document.visibilityState === "hidden") {
      clearTimer();
    } else {
      // Give the user a fresh idle window after refocus — never fire
      // an immediate refresh on tab-refocus (would feel eerie even if
      // invisible).
      idleStartMs = Date.now();
      scheduleNext();
    }
  }

  function onAbort() {
    handle.stop();
  }

  // Install listeners.
  for (const ev of IDLE_EVENTS) {
    document.addEventListener(ev, onActivity, { passive: true });
  }
  document.addEventListener("visibilitychange", onVisibility);
  signal?.addEventListener("abort", onAbort);

  scheduleNext();

  const handle: IdleRefreshHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer();
      for (const ev of IDLE_EVENTS) {
        document.removeEventListener(ev, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      signal?.removeEventListener("abort", onAbort);
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Test helpers — exported under `_` prefix so production callers don't
// accidentally reach into internals.
// ---------------------------------------------------------------------------

/** Reset the global in-flight mutex. Only for tests. */
export function _resetAmbientRefreshForTests(): void {
  refreshInFlight = false;
}
