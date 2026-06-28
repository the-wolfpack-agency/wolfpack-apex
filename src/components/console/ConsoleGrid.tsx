/**
 * ConsoleGrid — responsive auto-fit grid that staggers its children into view.
 *
 * Reuses the existing reveal motion (`StaggeredItem` + the `.wp-stagger-item`
 * CSS) so the command center matches the chat widgets' reveal exactly. We wrap
 * each child in a <StaggeredItem as="div"> with an incrementing index, which
 * the shared CSS turns into a top-to-bottom cascade (and snaps to final state
 * under prefers-reduced-motion — handled entirely in globals.css).
 *
 * Note: we deliberately do NOT call `useStaggeredReveal` here. That hook fires
 * an analytics event, and this kit is pure presentational — the consuming page
 * owns analytics. We only reuse the visual <StaggeredItem> wrapper.
 */

"use client";

import { Children, type CSSProperties, type ReactNode } from "react";
import { StaggeredItem, DEFAULT_STAGGER_MS } from "../widgets/StaggeredItem";

export interface ConsoleGridProps {
  children: ReactNode;
  /** Minimum column width before wrapping. Default 240px. */
  minColWidth?: number;
  /** Gap between cells (px). Default 16. */
  gap?: number;
  /** Per-item stagger (ms). Default DEFAULT_STAGGER_MS (40). */
  staggerMs?: number;
  /** Disable the staggered reveal (children render flat). */
  stagger?: boolean;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function ConsoleGrid({
  children,
  minColWidth = 240,
  gap = 16,
  staggerMs = DEFAULT_STAGGER_MS,
  stagger = true,
  className,
  style,
  testId,
}: ConsoleGridProps) {
  const items = Children.toArray(children);

  return (
    <div
      data-testid={testId ?? "console-grid"}
      data-count={items.length}
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minColWidth}px), 1fr))`,
        gap,
        ...style,
      }}
    >
      {items.map((child, i) =>
        stagger ? (
          <StaggeredItem
            as="div"
            key={i}
            index={i}
            staggerMs={staggerMs}
            data-testid={`console-grid-item-${i}`}
          >
            {child}
          </StaggeredItem>
        ) : (
          <div key={i} data-testid={`console-grid-item-${i}`}>
            {child}
          </div>
        ),
      )}
    </div>
  );
}

export default ConsoleGrid;
