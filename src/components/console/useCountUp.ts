/**
 * useCountUp — animate a number from 0 → target on mount via requestAnimationFrame.
 *
 * Respects prefers-reduced-motion: when the user prefers reduced motion (or the
 * value isn't a finite number, or RAF is unavailable, e.g. SSR/jsdom), it
 * returns the final value immediately with no animation. Eases out so the
 * count decelerates into place like a real instrument readout.
 *
 * Pure hook — no DOM writes, no analytics. The caller formats the returned
 * number however it likes (the MetricTile keeps the caller's decimal places).
 */

"use client";

import { useEffect, useRef, useState } from "react";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true; // SSR / test default: no animation, instant value.
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

export interface UseCountUpOptions {
  /** Animation duration in ms. Default 700. */
  durationMs?: number;
  /** Disable animation entirely (always snap to target). */
  disabled?: boolean;
}

/**
 * Returns the current animated value, settling at `target`. Re-runs the
 * animation if `target` changes.
 */
export function useCountUp(target: number, options: UseCountUpOptions = {}): number {
  const { durationMs = 700, disabled = false } = options;
  const finite = Number.isFinite(target) ? target : 0;
  const [value, setValue] = useState<number>(() =>
    disabled || prefersReducedMotion() ? finite : 0,
  );
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (disabled || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setValue(finite);
      return;
    }
    let start: number | null = null;
    const from = 0;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const elapsed = ts - start;
      const t = Math.min(1, elapsed / Math.max(1, durationMs));
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (finite - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setValue(finite);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [finite, durationMs, disabled]);

  return value;
}
