/**
 * StaggeredItem + useStaggeredReveal — chat-widget item reveal motion.
 *
 * Inspired by the way ChatGPT + Linear stagger list rows: each item
 * fades + translates up from 8px over ~180ms, offset by
 * `index * staggerMs` so the eye reads top-to-bottom instead of
 * being slapped with a fully-formed list.
 *
 * Pure CSS — no JS animation library. The reveal is driven by the
 * `.wp-stagger-item` class in `src/app/globals.css` reading the
 * `--wp-stagger-delay` custom property we set per item.
 *
 * Reduced motion: the CSS handles it. `@media (prefers-reduced-motion:
 * reduce)` snaps items to their final visible state (opacity 1,
 * translate 0) with no animation. No JS branching needed — keeps the
 * component dumb and the DOM identical regardless of motion preference.
 *
 * Click handlers / links on children still work normally: we don't
 * wrap or intercept anything. `pointer-events` and event propagation
 * are untouched.
 */

"use client";

import { createElement, useEffect, type CSSProperties, type ReactNode } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export const DEFAULT_STAGGER_MS = 40;

/* ============================================================
 * Props
 * ============================================================ */

export interface StaggeredItemProps {
  /** Zero-based position in the parent list. Drives the
   *  `index * staggerMs` animation-delay. */
  index: number;
  /** Per-item stagger in milliseconds. Default 40ms — feels alive
   *  without dragging on a 5-row list. */
  staggerMs?: number;
  /** Which DOM tag to render. Defaults to "li". Use "div" for grid
   *  cards (DmsInventory) or any non-list container. Limited to the
   *  small set of tags we actually use to keep the props surface
   *  tight; broaden if a future widget needs more. */
  as?: "li" | "div" | "tr" | "section" | "article";
  /** Pass-through className — merged with the wp-stagger-item hook. */
  className?: string;
  /** Pass-through inline style — merged with --wp-stagger-delay. */
  style?: CSSProperties;
  /** Any data-* / aria-* / key click handlers the caller wants
   *  forwarded onto the rendered tag. Kept loose because the wrapper
   *  is a transparent surface. */
  [key: `data-${string}`]: string | number | boolean | undefined;
  /** Children render directly inside the tag. */
  children?: ReactNode;
  /** onClick is forwarded so callers can keep their row interactions. */
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * Renders a single staggered child. Sets the `--wp-stagger-delay`
 * inline style so the CSS `.wp-stagger-item` class can pick it up.
 *
 * Multiple `className`s merge: the caller's className stays, we
 * just append `wp-stagger-item`.
 */
export function StaggeredItem({
  index,
  staggerMs = DEFAULT_STAGGER_MS,
  as,
  className,
  style,
  children,
  onClick,
  ...rest
}: StaggeredItemProps) {
  const tag = as ?? "li";
  const delay = `${Math.max(0, index) * staggerMs}ms`;
  const merged = ["wp-stagger-item", className].filter(Boolean).join(" ");
  const mergedStyle: CSSProperties = {
    ...(style ?? {}),
    ["--wp-stagger-delay" as never]: delay,
  };
  return createElement(
    tag,
    {
      ...rest,
      className: merged,
      style: mergedStyle,
      onClick,
      "data-stagger-index": index,
    },
    children,
  );
}

/* ============================================================
 * Hook — one-shot analytics ping on widget mount
 * ============================================================ */

export interface UseStaggeredRevealArgs {
  /** Widget identifier (e.g. "calendar", "email_thread"). Goes into
   *  the analytics payload so dashboards can slice motion telemetry
   *  per widget. */
  widgetKind: string;
  /** How many items were rendered (after empty-state branching). */
  itemCount: number;
  /** Optional per-turn correlation id, threaded into the event
   *  metadata so motion data joins the chat() funnel. */
  workflowId?: string;
  /** Override the default stagger if the widget tuned it. */
  staggerMs?: number;
}

/**
 * Fire `assistant.widget.items_revealed` exactly once per mount.
 *
 * Skips firing when itemCount is 0 — an empty state isn't a reveal,
 * and we don't want to inflate the analytics signal with no-op rows.
 */
export function useStaggeredReveal({
  widgetKind,
  itemCount,
  workflowId,
  staggerMs = DEFAULT_STAGGER_MS,
}: UseStaggeredRevealArgs): void {
  useEffect(() => {
    if (itemCount <= 0) return;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget.items_revealed",
        metadata: {
          widget_kind: widgetKind,
          item_count: itemCount,
          stagger_ms: staggerMs,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
    /* Fire once per (widget, count, workflow) tuple. Re-renders that
     * don't change the spec shouldn't re-fire. */
  }, [widgetKind, itemCount, staggerMs, workflowId]);
}
