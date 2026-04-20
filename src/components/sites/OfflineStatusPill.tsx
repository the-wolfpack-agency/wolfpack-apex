"use client";

/**
 * OfflineStatusPill — persistent top-right indicator for offline state.
 *
 * Three states:
 *   - Online (queue empty)        → "Online" pill, green
 *   - Offline (any queue size)    → "Offline — N edits queued" pill, amber
 *   - Online + flushing           → "Syncing N edits..." pill, blue
 *   - Online + failed entries     → "N edits failed — retry" pill, red
 *
 * The pill subscribes to window `online` / `offline` events, and to a
 * custom `instinct-offline-queue-changed` event that the offline-queue
 * module dispatches whenever enqueue/flush happens. This keeps the
 * pill reactive without prop-drilling state through the layout.
 *
 * On transition offline → online we automatically call flushQueue(),
 * so the pill is not just display — it IS the replay trigger. This
 * keeps the offline subsystem self-contained: any component that
 * enqueues a mutation gets flush-on-reconnect "for free" as long as
 * the pill is mounted (it is — dashboard layout).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  flushQueue,
  listQueue,
  type QueuedMutation,
} from "@/lib/offline-queue";

type PillMode = "online" | "offline" | "syncing" | "failed";

interface PillState {
  mode: PillMode;
  pending: number;
  failed: number;
}

const CHANGE_EVENT = "instinct-offline-queue-changed";

/**
 * Helper that other modules can call to notify the pill when they
 * enqueue / drain / delete entries. Kept exported so tests can fire it.
 */
export function notifyQueueChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function formatMode(state: PillState): { label: string; tone: PillMode } {
  if (state.mode === "syncing") {
    return { label: `Syncing ${state.pending} edit${state.pending === 1 ? "" : "s"}...`, tone: "syncing" };
  }
  if (state.mode === "offline") {
    const n = state.pending;
    if (n === 0) return { label: "Offline", tone: "offline" };
    return { label: `Offline — ${n} edit${n === 1 ? "" : "s"} queued`, tone: "offline" };
  }
  if (state.mode === "failed") {
    return {
      label: `${state.failed} edit${state.failed === 1 ? "" : "s"} failed — retry`,
      tone: "failed",
    };
  }
  return { label: "Online", tone: "online" };
}

function TONE_COLORS(tone: PillMode): { bg: string; fg: string; dot: string } {
  switch (tone) {
    case "offline":
      return { bg: "rgba(234, 179, 8, 0.15)", fg: "#eab308", dot: "#eab308" };
    case "syncing":
      return { bg: "rgba(59, 130, 246, 0.15)", fg: "#3b82f6", dot: "#3b82f6" };
    case "failed":
      return { bg: "rgba(239, 68, 68, 0.15)", fg: "#ef4444", dot: "#ef4444" };
    default:
      return { bg: "rgba(34, 197, 94, 0.15)", fg: "#22c55e", dot: "#22c55e" };
  }
}

export interface OfflineStatusPillProps {
  /** Override for testing — defaults to navigator.onLine. */
  initialOnline?: boolean;
  /** Inject a flush impl for tests. */
  flushImpl?: typeof flushQueue;
  /** Inject list impl for tests. */
  listImpl?: typeof listQueue;
  /** Analytics hook (tests). */
  onAnalytics?: (event: string, metadata: Record<string, string | number | boolean>) => void;
}

export default function OfflineStatusPill({
  initialOnline,
  flushImpl,
  listImpl,
  onAnalytics,
}: OfflineStatusPillProps = {}) {
  const [state, setState] = useState<PillState>(() => ({
    mode:
      typeof navigator !== "undefined" && !(initialOnline ?? navigator.onLine)
        ? "offline"
        : "online",
    pending: 0,
    failed: 0,
  }));
  const [visible, setVisible] = useState(true);
  const flushing = useRef(false);

  const flush = flushImpl ?? flushQueue;
  const list = listImpl ?? listQueue;

  const emit = useCallback(
    (event: string, metadata: Record<string, string | number | boolean>) => {
      if (onAnalytics) onAnalytics(event, metadata);
      // The queue module fires its own analytics for mutation_* and
      // returned_online; we only fire offline.detected here.
    },
    [onAnalytics],
  );

  const refresh = useCallback(async () => {
    try {
      const rows: QueuedMutation[] = await list();
      const pending = rows.filter((r) => r.status === "pending").length;
      const failed = rows.filter((r) => r.status === "failed").length;
      const isOnline =
        typeof navigator === "undefined" ? true : navigator.onLine;
      setState((prev) => {
        if (flushing.current) {
          return { mode: "syncing", pending, failed };
        }
        if (!isOnline) return { mode: "offline", pending, failed };
        if (failed > 0 && pending === 0) return { mode: "failed", pending, failed };
        return { mode: "online", pending, failed };
      });
    } catch {
      /* ignore */
    }
  }, [list]);

  const tryFlush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      await refresh();
      setState((s) => ({ ...s, mode: "syncing" }));
      await flush();
    } finally {
      flushing.current = false;
      await refresh();
    }
  }, [flush, refresh]);

  useEffect(() => {
    void refresh();

    const onOnline = () => {
      emit("offline.returned_online", {});
      void tryFlush();
    };
    const onOffline = () => {
      emit("offline.detected", {});
      void refresh();
    };
    const onQueueChange = () => {
      void refresh();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      window.addEventListener(CHANGE_EVENT, onQueueChange);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener(CHANGE_EVENT, onQueueChange);
      }
    };
  }, [emit, refresh, tryFlush]);

  if (!visible) return null;

  const { label, tone } = formatMode(state);
  const colors = TONE_COLORS(tone);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-status-pill"
      data-mode={tone}
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.fg}`,
        backdropFilter: "blur(6px)",
        cursor: tone === "failed" ? "pointer" : "default",
      }}
      onClick={() => {
        if (tone === "failed") void tryFlush();
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: colors.dot,
          animation: tone === "syncing" ? "pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      <span>{label}</span>
      {tone === "online" && state.pending === 0 && state.failed === 0 ? (
        <button
          aria-label="Dismiss online indicator"
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
          }}
          style={{
            background: "transparent",
            border: 0,
            color: "inherit",
            cursor: "pointer",
            padding: 0,
            marginLeft: 4,
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
