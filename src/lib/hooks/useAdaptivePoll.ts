"use client";

/**
 * useAdaptivePoll — fires `callback` on a faster interval when the
 * tab is visible (5s) and a slower interval when hidden (45s). Same
 * battery profile as the static 45s baseline when the user is away,
 * but 9× faster perceived latency when they're actually looking at
 * the screen.
 *
 * Used by Teams unread badges + chat list refresh on /messages so
 * new messages surface in seconds, not the full 45s window.
 *
 * Behavior:
 *   - Fires `callback` immediately on mount.
 *   - Re-fires when the tab regains visibility (the user just came
 *     back; they want fresh data NOW).
 *   - Re-fires on window focus too (some browsers fire focus without
 *     visibilitychange — belt and suspenders).
 *   - Switches the timer cadence whenever document.visibilityState
 *     changes.
 *   - Cleans up the interval + listeners on unmount.
 *
 * Defaults: 5s visible, 45s hidden. Override via opts.
 */

import { useCallback, useEffect, useRef } from "react";

export interface AdaptivePollOptions {
  /** Interval ms when the tab is visible. Default 5_000. */
  visibleMs?: number;
  /** Interval ms when the tab is hidden. Default 45_000. */
  hiddenMs?: number;
}

export function useAdaptivePoll(
  callback: () => void,
  opts: AdaptivePollOptions = {},
): void {
  const { visibleMs = 5_000, hiddenMs = 45_000 } = opts;
  // Latest callback ref so we don't restart the interval on every
  // render just because the consumer's callback identity changed.
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  const fire = useCallback(() => {
    try {
      cbRef.current();
    } catch {
      /* never let consumer errors break the interval */
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let id: ReturnType<typeof setInterval> | null = null;

    function currentMs(): number {
      return document.visibilityState === "visible" ? visibleMs : hiddenMs;
    }
    function startTimer() {
      if (id) clearInterval(id);
      id = setInterval(fire, currentMs());
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        // Coming back to the tab → fire immediately so the user
        // sees fresh data on the next paint.
        fire();
      }
      startTimer();
    }
    function onFocus() {
      fire();
    }

    // Kick off: fire once + start the timer.
    fire();
    startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [fire, visibleMs, hiddenMs]);
}
