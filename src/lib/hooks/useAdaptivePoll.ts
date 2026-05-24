"use client";

/**
 * useAdaptivePoll — fires `callback` on a slow interval when the tab
 * is visible (default 30s), an even slower interval when hidden
 * (default 120s), and an idle interval (default 180s) once the result
 * has been "stable" for `idleAfterStablePolls` consecutive polls.
 *
 * Re-fires immediately on tab refocus or visibility change so the
 * user always sees fresh data the moment they look at the screen.
 *
 * Used by the four sidebar/topbar badges (Email, Messages, Teams,
 * NewMessageToast). Combined with the coalesce wrapper in
 * `src/lib/coalesced-fetch.ts`, the four badges produce ~4 reqs/min
 * idle (one per unique URL × ~2 polls/min) instead of the previous
 * 48 reqs/min (4 badges × 12 polls/min). Idle backoff drops it
 * further to ~2 reqs/min after a few stable polls.
 *
 * Energy / efficiency note: prior defaults (5s visible, 45s hidden)
 * were left over from a pre-coalesce era when each badge *had to*
 * poll fast to compensate for the others. With server-side change
 * notifications still aspirational, the new defaults trade ~30s of
 * perceived latency on a notification dot for an 85%+ idle-traffic
 * reduction.
 *
 * Defaults: 30s visible, 120s hidden, 180s idle. Override via opts.
 */

import { useCallback, useEffect, useRef } from "react";

export interface AdaptivePollOptions {
  /** Interval ms when the tab is visible. Default 30_000. */
  visibleMs?: number;
  /** Interval ms when the tab is hidden. Default 120_000. */
  hiddenMs?: number;
  /** Interval ms after the result has been stable. Default 180_000. */
  idleMs?: number;
  /**
   * Number of consecutive `isStable() === true` polls before the
   * timer downshifts to `idleMs`. Default 5. Any unstable poll
   * resets the counter back to the visible/hidden cadence.
   */
  idleAfterStablePolls?: number;
  /**
   * Optional stability hint. Called synchronously after every fire
   * to decide whether the poll's result was "the same as last time".
   * Returning `true` for `idleAfterStablePolls` consecutive polls
   * promotes the timer to `idleMs`. Returning `false` resets.
   *
   * If omitted, idle backoff never engages — only visible/hidden
   * cadence applies (matches the pre-2026-05-01 hook behavior).
   */
  isStable?: () => boolean;
}

export function useAdaptivePoll(
  callback: () => void,
  opts: AdaptivePollOptions = {},
): void {
  /* 2026-05-23: defaults bumped 2x (30→60 visible, 120→300 hidden,
   * 180→600 idle) after Nick reported 139 requests on an idle assistant
   * page. With ~7 active pollers across the dashboard (4 nav badges +
   * chat live-updates + notifications + presence), 30s visible meant
   * ~14 reqs/min baseline. 60s halves that to ~7/min. The latency cost
   * is at most an extra 30s delay on a notification dot updating;
   * worth it for the bandwidth and server-load savings. */
  const {
    visibleMs = 60_000,
    hiddenMs = 300_000,
    idleMs = 600_000,
    idleAfterStablePolls = 5,
    isStable,
  } = opts;
  const cbRef = useRef(callback);
  const stableHintRef = useRef(isStable);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);
  useEffect(() => {
    stableHintRef.current = isStable;
  }, [isStable]);

  const stableCountRef = useRef(0);
  const lastFireAtRef = useRef(0);

  const fire = useCallback(() => {
    lastFireAtRef.current = Date.now();
    try {
      cbRef.current();
    } catch {
      /* never let consumer errors break the schedule */
    }
    const sf = stableHintRef.current;
    if (sf) {
      try {
        if (sf()) {
          stableCountRef.current += 1;
        } else {
          stableCountRef.current = 0;
        }
      } catch {
        stableCountRef.current = 0;
      }
    }
  }, []);

  /* If a poll fired in the last REFOCUS_DEBOUNCE_MS, skip the
   * visibility/focus immediate re-fire. Dev work with frequent
   * tab-switching used to fire all N pollers on every alt-tab,
   * inflating idle traffic ~5x. The debounce caps that. */
  const REFOCUS_DEBOUNCE_MS = 15_000;
  const maybeRefireOnRefocus = useCallback(() => {
    if (Date.now() - lastFireAtRef.current >= REFOCUS_DEBOUNCE_MS) {
      stableCountRef.current = 0;
      fire();
    }
  }, [fire]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const currentMs = (): number => {
      const isVisible = document.visibilityState === "visible";
      if (!isVisible) return hiddenMs;
      if (
        stableHintRef.current &&
        stableCountRef.current >= idleAfterStablePolls
      ) {
        return idleMs;
      }
      return visibleMs;
    };

    const schedule = (): void => {
      if (cancelled) return;
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        fire();
        schedule();
      }, currentMs());
    };

    const cancel = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        // Tab regained focus — re-fire only if it's been a while
        // (REFOCUS_DEBOUNCE_MS) since the last poll. Without this
        // every alt-tab fires all N pollers immediately.
        maybeRefireOnRefocus();
      }
      cancel();
      schedule();
    };
    const onFocus = (): void => {
      maybeRefireOnRefocus();
    };

    // Kick off: fire once + schedule the next tick.
    fire();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      cancel();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [fire, maybeRefireOnRefocus, visibleMs, hiddenMs, idleMs, idleAfterStablePolls]);
}
