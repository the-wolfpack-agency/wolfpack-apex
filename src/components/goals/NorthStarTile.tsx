"use client";

/**
 * NorthStarTile — top-center tile on /goals.
 *
 * Shows the latest North Star value plus a 14-point sparkline. Zero
 * external dep; the sparkline is an inline SVG polyline so the tile
 * renders even on first-load before the chart library hydrates.
 *
 * Used standalone on /goals AND as the anchor for GoalsDashboardTile.
 */

import type { CSSProperties } from "react";

export interface NorthStarPoint {
  value: number;
  captured_at: string;
}

export interface NorthStarTileProps {
  label: string | null;
  value: number | null;
  unit: string | null;
  history: NorthStarPoint[];
  target?: number | null;
  compact?: boolean;
}

export default function NorthStarTile({
  label,
  value,
  unit,
  history,
  target,
  compact,
}: NorthStarTileProps) {
  const hasData = value != null && label != null;

  // Compute pct change vs. previous point (the one just before latest in
  // chronological order).
  let pctChange: number | null = null;
  if (history.length >= 2) {
    const prev = history[history.length - 2].value;
    if (prev !== 0 && value != null) {
      pctChange = Math.round(((value - prev) / prev) * 1000) / 10;
    }
  }

  const spark = buildSparkline(history, compact ? 120 : 260, compact ? 32 : 56);

  const padding = compact ? "p-3" : "p-5";
  const valueClass = compact ? "text-xl font-bold" : "text-4xl font-bold";
  const labelClass = compact ? "text-[10px]" : "text-xs";

  return (
    <div
      data-testid="north-star-tile"
      className={`rounded-lg border ${padding}`}
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className={`${labelClass} uppercase tracking-wide`}
          style={{ color: "var(--wp-text-muted)" }}
        >
          North Star
        </span>
        {pctChange != null && (
          <span
            className={`${labelClass} px-1.5 py-0.5 rounded font-semibold`}
            style={{
              background:
                pctChange >= 0 ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
              color: pctChange >= 0 ? "var(--wp-success)" : "var(--wp-error)",
            }}
          >
            {pctChange >= 0 ? "↑" : "↓"}
            {Math.abs(pctChange)}%
          </span>
        )}
      </div>

      {hasData ? (
        <>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={valueClass} style={{ color: "var(--wp-gold)" }}>
              {formatValueWithUnit(value!, unit ?? null)}
            </span>
          </div>
          <p className={`${labelClass} mt-0.5`} style={{ color: "var(--wp-text-dim)" }}>
            {label}
            {target != null && ` — target ${formatValueWithUnit(target, unit ?? null)}`}
          </p>
          {spark && (
            <svg
              role="img"
              aria-label={`${label} sparkline`}
              viewBox={`0 0 ${spark.w} ${spark.h}`}
              className="w-full mt-3"
              style={{ display: "block" }}
            >
              <polyline
                points={spark.points}
                fill="none"
                stroke="var(--wp-gold)"
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            </svg>
          )}
        </>
      ) : (
        <div className={`${labelClass} mt-2`} style={{ color: "var(--wp-text-muted)" }}>
          No North Star yet. An admin can set one from the “Update North Star”
          button on /goals.
        </div>
      )}
    </div>
  );
}

export function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return `${v}`;
  return v.toFixed(1);
}

const CURRENCY_PREFIXES = new Set(["$", "€", "£", "¥", "₹", "USD", "EUR", "GBP", "JPY", "INR"]);

/** Render "$1.0B" when the unit is a currency, "1.0B qps" otherwise. */
export function formatValueWithUnit(v: number, unit: string | null): string {
  const formatted = formatValue(v);
  if (!unit) return formatted;
  const trimmed = unit.trim();
  if (CURRENCY_PREFIXES.has(trimmed)) return `${trimmed}${formatted}`;
  return `${formatted} ${trimmed}`;
}

function buildSparkline(
  points: NorthStarPoint[],
  w: number,
  h: number,
): { w: number; h: number; points: string } | null {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = w / (points.length - 1);
  const pts = points
    .map((p, i) => {
      const x = (i * stepX).toFixed(1);
      const y = (h - ((p.value - min) / range) * h).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
  return { w, h, points: pts };
}

// Small utility class so downstream components can share the tile chrome
// without duplicating the inline style block.
export const tileCardStyle: CSSProperties = {
  background: "var(--wp-dark-surface)",
  borderColor: "var(--wp-dark-border)",
};
