/**
 * MetricTile — the hero "view results" element of the command center.
 *
 * A large value + label, with optional delta (up/down, success/error tinted),
 * an optional accent color for the value, and an optional sparkline slot. The
 * numeric value counts up from 0 on mount (RAF; instant under
 * prefers-reduced-motion via useCountUp). Build it on the --wp-* tokens only.
 *
 * Pure presentational. The caller owns the data + any analytics.
 */

"use client";

import type { CSSProperties, ReactNode } from "react";
import { useCountUp } from "./useCountUp";

export interface MetricDelta {
  /** Signed magnitude of change. Sign drives the arrow + color when
   *  `direction` is omitted. */
  value: number;
  /** Force the direction; otherwise inferred from the sign of `value`. */
  direction?: "up" | "down" | "flat";
  /** When true, a downward move is GOOD (e.g. fewer vulnerabilities) so the
   *  color mapping inverts. Default false (up = good = success). */
  invertColor?: boolean;
  /** Override the rendered delta text (defaults to a +/- formatted value). */
  label?: ReactNode;
}

export interface MetricTileProps {
  /** Big number. Use `value` for numbers (gets count-up) or `display` for a
   *  pre-formatted / non-numeric value (no count-up). */
  value?: number;
  /** Pre-formatted display string; takes precedence over `value`. */
  display?: ReactNode;
  /** Small caption under/over the value. */
  label: ReactNode;
  /** Optional kicker line above the value (e.g. a unit or a scope). */
  kicker?: ReactNode;
  /** Decimal places for the animated numeric value. Default 0. */
  decimals?: number;
  /** Accent color for the value text (any --wp-* var expression). */
  accent?: string;
  /** Optional delta indicator. */
  delta?: MetricDelta;
  /** Optional trailing slot — typically a <Sparkline />. */
  sparkline?: ReactNode;
  /** Disable count-up explicitly (e.g. in a list that re-renders often). */
  animate?: boolean;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

function formatNumber(n: number, decimals: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function MetricTile({
  value,
  display,
  label,
  kicker,
  decimals = 0,
  accent,
  delta,
  sparkline,
  animate = true,
  className,
  style,
  testId,
}: MetricTileProps) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const animated = useCountUp(numeric ? (value as number) : 0, {
    disabled: !animate || !numeric,
  });

  const shownValue: ReactNode =
    display != null
      ? display
      : numeric
        ? formatNumber(animated, decimals)
        : "—";

  // Delta direction + color
  let deltaNode: ReactNode = null;
  if (delta) {
    const dir =
      delta.direction ??
      (delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat");
    const good =
      dir === "flat"
        ? "neutral"
        : delta.invertColor
          ? dir === "down"
            ? "good"
            : "bad"
          : dir === "up"
            ? "good"
            : "bad";
    const deltaColor =
      good === "good"
        ? "var(--wp-success, #22c55e)"
        : good === "bad"
          ? "var(--wp-error, #ef4444)"
          : "var(--wp-text-muted, #929cad)";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
    const text =
      delta.label ??
      `${delta.value > 0 ? "+" : ""}${formatNumber(delta.value, decimals)}`;
    deltaNode = (
      <span
        data-testid="metric-delta"
        data-direction={dir}
        data-sentiment={good}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 12,
          fontWeight: 600,
          color: deltaColor,
        }}
      >
        <span aria-hidden style={{ fontSize: 9 }}>
          {arrow}
        </span>
        {text}
      </span>
    );
  }

  return (
    <div
      data-testid={testId ?? "metric-tile"}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        ...style,
      }}
    >
      {kicker != null && (
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--wp-text-muted, #929cad)",
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {kicker}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 10,
          // A long pre-formatted display string + sparkline must wrap rather
          // than force the tile wider than its grid track.
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <span
          data-testid="metric-value"
          style={{
            fontSize: 30,
            fontWeight: 700,
            lineHeight: 1.05,
            color: accent ?? "var(--wp-text, #e9edf4)",
            fontVariantNumeric: "tabular-nums",
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {shownValue}
        </span>
        {sparkline != null && (
          <span data-testid="metric-sparkline" style={{ paddingBottom: 2 }}>
            {sparkline}
          </span>
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          data-testid="metric-label"
          style={{
            fontSize: 12,
            color: "var(--wp-text-dim, #b4bcc8)",
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {label}
        </span>
        {deltaNode}
      </div>
    </div>
  );
}

export default MetricTile;
