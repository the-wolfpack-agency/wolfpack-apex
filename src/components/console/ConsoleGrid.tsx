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
        // minmax(min(100%, Npx), 1fr): the inner min() clamps each track to the
        // container width so a wide minColWidth can never push the grid past a
        // narrow (e.g. 360px) viewport. Tracks collapse cleanly to 1 column.
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minColWidth}px), 1fr))`,
        gap,
        // Belt-and-braces: keep the grid itself from ever exceeding its parent.
        minWidth: 0,
        maxWidth: "100%",
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
            // minWidth:0 lets a cell shrink below its content's intrinsic width
            // (the default for grid items is min-content), so long unbreakable
            // content can't force a track wider than the column.
            style={{ minWidth: 0 }}
          >
            {child}
          </StaggeredItem>
        ) : (
          <div
            key={i}
            data-testid={`console-grid-item-${i}`}
            style={{ minWidth: 0 }}
          >
            {child}
          </div>
        ),
      )}
    </div>
  );
}

export default ConsoleGrid;
