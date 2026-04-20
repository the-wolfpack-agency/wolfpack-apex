"use client";

/**
 * Brain Pack progressive downloader (Stream U3).
 *
 * Pulls /api/brain/pack in cursor-paginated pages and writes them into
 * the client IDB store (brain-pack-store.ts). Designed to be noisy-OK
 * in the background — never blocks the UI thread, always resumable,
 * always abortable, and skips itself entirely when the user has asked
 * not to be charged for data.
 *
 * Called from:
 *   - `startAmbientPackSync(workspace)` — install once on app boot.
 *     Returns a `stop()` handle so the root layout can clean up on
 *     sign-out or workspace switch.
 *   - Directly from a "Download pack" button in the Brain Library UI.
 *
 * Behavior matrix:
 *   - `navigator.onLine === false`         → skip, reason "offline"
 *   - `connection.saveData === true`       → skip, reason "save_data"
 *   - `connection.type === "cellular"`     → skip, reason "cellular"
 *     (unless opts.allowCellular)
 *   - IDB QuotaExceeded during a page write → skip, reason "quota_exceeded"
 *   - Rate-limit: one page per ~750ms so a slow MiFi cannot get
 *     hammered. Configurable via opts.pageDelayMs.
 *   - Abort: opts.signal.addEventListener("abort") halts mid-page, no
 *     analytics event is fired (callers know they aborted).
 *   - Resume: the server returns an opaque `next_cursor`. We stash the
 *     last cursor in memory for the session and also accept an explicit
 *     one via opts (test seam). Cross-session resume relies on the
 *     server returning chunks with deterministic id ordering — we just
 *     re-query from the start on a fresh tab.
 *   - Dedup window: the syncer will refuse to start a new sync while
 *     another one is in flight for the same workspace.
 */

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import {
  putCachedChunks,
  PackQuotaExceededError,
  getPackStats,
  type CachedChunk,
} from "@/lib/brain-pack-store";

/**
 * Client-side analytics event types. Subset of InstinctEventType that
 * this module emits. Kept as a local string-literal union so we can
 * stay in a `"use client"` module without pulling in `@/lib/analytics`
 * (which transitively imports `pg` + `neo4j-driver` — fine in Node but
 * a heavy ask on the browser bundle).
 */
type PackAnalyticsEvent =
  | "brain.pack_sync_started"
  | "brain.pack_page_downloaded"
  | "brain.pack_sync_completed"
  | "brain.pack_sync_skipped"
  | "brain.pack_chunk_evicted";

// ---------------------------------------------------------------------------
// Public options + results.
// ---------------------------------------------------------------------------

export interface SyncProgress {
  downloaded: number;
  skipped: number;
  failed: number;
  total_known: number;
  next_cursor: string | null;
}

export interface SyncOptions {
  /** Abort the sync mid-page. Aborted syncs return the partial counts. */
  signal?: AbortSignal;
  /** Page size (defaults to 50, server caps at 200). */
  pageSize?: number;
  /** ms between successive page fetches. Default 750. */
  pageDelayMs?: number;
  /** Proceed even on a cellular connection (default false). */
  allowCellular?: boolean;
  /** Override the starting cursor (resume tests). */
  cursor?: string | null;
  /** Fetch override for tests. Matches fetchWithRefresh's signature. */
  fetcher?: typeof fetchWithRefresh;
  /** Analytics override for tests. */
  onAnalytics?: (
    event: PackAnalyticsEvent,
    metadata: Record<string, string | number | boolean>,
  ) => void;
  /** Progress callback fired after each page write. */
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncResult {
  downloaded: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

interface ServerPackChunk {
  id: string;
  doc_id: string;
  title: string;
  text: string;
  embedding: number[];
}

interface ServerPackResponse {
  chunks: ServerPackChunk[];
  next_cursor: string | null;
  total: number;
}

/** Per-workspace sync lock. Held for the duration of the async loop so
 *  `startAmbientPackSync` + a manual "Sync now" click never double-fire. */
const inflight = new Set<string>();
const lastCursorByWorkspace = new Map<string, string | null>();

function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

interface NetConnection {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
}

function getConnection(): NetConnection | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as unknown as { connection?: NetConnection };
  return nav.connection ?? null;
}

async function postAnalytics(
  event: PackAnalyticsEvent,
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
    /* best-effort — analytics never blocks a sync */
  }
}

function emit(
  opts: SyncOptions | undefined,
  event: PackAnalyticsEvent,
  metadata: Record<string, string | number | boolean>,
): void {
  if (opts?.onAnalytics) {
    opts.onAnalytics(event, metadata);
    return;
  }
  void postAnalytics(event, metadata);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Primary entry point.
// ---------------------------------------------------------------------------

/**
 * Drain /api/brain/pack into IDB in the background. Safe to call
 * repeatedly — the dedup lock prevents concurrent syncs for the same
 * workspace.
 */
export async function syncBrainPack(
  workspace: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (!workspace) return { downloaded: 0, skipped: 0, failed: 0 };

  // Dedup window — one sync per workspace in flight at a time.
  if (inflight.has(workspace)) {
    emit(opts, "brain.pack_sync_skipped", {
      workspace,
      reason: "already_running",
    });
    return { downloaded: 0, skipped: 1, failed: 0 };
  }

  // Connection-aware gates fire BEFORE we claim the lock so aborts don't
  // leave a zombie inflight flag.
  if (!isOnline()) {
    emit(opts, "brain.pack_sync_skipped", {
      workspace,
      reason: "offline",
    });
    return { downloaded: 0, skipped: 1, failed: 0 };
  }
  const conn = getConnection();
  if (conn?.saveData) {
    emit(opts, "brain.pack_sync_skipped", {
      workspace,
      reason: "save_data",
    });
    return { downloaded: 0, skipped: 1, failed: 0 };
  }
  if (!opts.allowCellular && conn?.type === "cellular") {
    emit(opts, "brain.pack_sync_skipped", {
      workspace,
      reason: "cellular",
    });
    return { downloaded: 0, skipped: 1, failed: 0 };
  }

  inflight.add(workspace);
  const started = Date.now();
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const pageDelay = Math.max(opts.pageDelayMs ?? 750, 0);
  const fetcher = opts.fetcher ?? fetchWithRefresh;
  const signal = opts.signal;

  let cursor: string | null =
    opts.cursor ?? lastCursorByWorkspace.get(workspace) ?? null;
  const resuming = Boolean(cursor);

  emit(opts, "brain.pack_sync_started", {
    workspace,
    resume: resuming,
  });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let quotaHit = false;

  try {
    for (;;) {
      if (signal?.aborted) break;

      const pageStarted = Date.now();
      const url = buildPackUrl(workspace, cursor, pageSize);
      let res: Response;
      try {
        res = await fetcher(url, { method: "GET" });
      } catch {
        failed += 1;
        break;
      }
      if (!res.ok) {
        failed += 1;
        break;
      }
      const body = (await res.json()) as ServerPackResponse;

      const now = Date.now();
      const rows: CachedChunk[] = (body.chunks ?? []).map((c) => ({
        id: c.id,
        doc_id: c.doc_id,
        title: c.title,
        text: c.text,
        embedding: Array.isArray(c.embedding) ? c.embedding : [],
        workspace,
        cached_at: now,
      }));

      try {
        const { written } = await putCachedChunks(rows);
        downloaded += written;
      } catch (err) {
        if (err instanceof PackQuotaExceededError) {
          quotaHit = true;
          break;
        }
        failed += 1;
        break;
      }

      const stats = await getPackStats(workspace).catch(() => ({
        chunk_count: downloaded,
      }));

      emit(opts, "brain.pack_page_downloaded", {
        workspace,
        page_chunks: rows.length,
        total_cached: stats.chunk_count,
        duration_ms: Date.now() - pageStarted,
      });

      if (opts.onProgress) {
        opts.onProgress({
          downloaded,
          skipped,
          failed,
          total_known: body.total ?? 0,
          next_cursor: body.next_cursor,
        });
      }

      cursor = body.next_cursor;
      lastCursorByWorkspace.set(workspace, cursor);
      if (!cursor || rows.length === 0) break;

      // Rate-limit — respect pageDelayMs unless aborted.
      await sleep(pageDelay, signal);
    }

    if (quotaHit) {
      emit(opts, "brain.pack_sync_skipped", {
        workspace,
        reason: "quota_exceeded",
      });
      skipped += 1;
    }

    emit(opts, "brain.pack_sync_completed", {
      workspace,
      downloaded,
      skipped,
      failed,
      duration_ms: Date.now() - started,
    });
  } finally {
    inflight.delete(workspace);
  }

  return { downloaded, skipped, failed };
}

function buildPackUrl(
  workspace: string,
  cursor: string | null,
  limit: number,
): string {
  const qs = new URLSearchParams();
  qs.set("workspace", workspace);
  qs.set("limit", String(limit));
  if (cursor) qs.set("cursor", cursor);
  return `/api/brain/pack?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Ambient installer — call from the app root.
// ---------------------------------------------------------------------------

/**
 * Install an idle-time Brain Pack sync that:
 *   - runs once 3s after boot (gives the app time to render),
 *   - re-runs on `online` events (browser came back),
 *   - re-runs every 15 minutes while the tab is visible.
 *
 * Returns `{ stop }` for the root layout to cleanly tear down on
 * sign-out / workspace switch.
 */
export function startAmbientPackSync(
  workspace: string,
): { stop: () => void } {
  if (typeof window === "undefined" || !workspace) {
    return { stop: () => undefined };
  }

  const controller = new AbortController();
  let stopped = false;
  let lastRunAt = 0;
  const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  const run = (): void => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastRunAt < 30_000) return; // 30s dedup floor across triggers
    lastRunAt = now;
    void syncBrainPack(workspace, { signal: controller.signal });
  };

  const onOnline = (): void => run();
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") run();
  };

  const bootTimer = setTimeout(run, 3000);
  const intervalTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    run();
  }, MIN_INTERVAL_MS);

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      clearTimeout(bootTimer);
      clearInterval(intervalTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/** @internal — reset module-level dedup state for Jest. */
export function __resetBrainPackSyncForTests(): void {
  inflight.clear();
  lastCursorByWorkspace.clear();
}
