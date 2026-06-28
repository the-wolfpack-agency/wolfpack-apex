/**
 * Sparkline — pure inline-SVG trend line. No charting dependency (DRY: we add
 * no new runtime dep). Embeds inside MetricTile or stands alone.
 *
 * Renders one <polyline> for the trend, an optional filled area under it, and
 * an optional dot on the most-recent point. Accent colour comes from a
 * --wp-* token (default --wp-info). Handles 0, 1, and n points gracefully:
 *   - 0 points  → an empty <svg> placeholder (keeps layout stable)
 *   - 1 point   → a flat baseline + the single dot
 *   - n points  → the trend line
 *
 * Purely presentational; no animation that needs reduced-motion handling
 * (a static SVG), so it is safe everywhere.
 */

"use client";

import { useId } from "react";

export interface SparklineProps {
  /** The series. Empty/short arrays are handled safely. */
  data: number[];
  /** Pixel width of the SVG viewport. */
  width?: number;
  /** Pixel height of the SVG viewport. */
  height?: number;
  /** Stroke width of the trend line. */
  strokeWidth?: number;
  /** Accent colour. Pass any --wp-* var expression; defaults to info blue. */
  accent?: string;
  /** Fill a translucent area under the line. */
  area?: boolean;
  /** Draw a dot on the final point. */
  showLastDot?: boolean;
  className?: string;
  testId?: string;
  /** Accessible label; falls back to a generic description. */
  ariaLabel?: string;
}

export function Sparkline({
  data,
  width = 88,
  height = 28,
  strokeWidth = 1.5,
  accent = "var(--wp-info, #3b82f6)",
  area = false,
  showLastDot = true,
  className,
  testId,
  ariaLabel,
}: SparklineProps) {
  const gradId = useId();
  // Inset so the stroke + dot never clip at the edges.
  const pad = Math.max(strokeWidth, 2);
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const innerW = Math.max(w - pad * 2, 1);
  const innerH = Math.max(h - pad * 2, 1);

  const points = Array.isArray(data) ? data.filter((n) => Number.isFinite(n)) : [];
  const n = points.length;

  // X for index i across the inner width.
  const xAt = (i: number) =>
    n <= 1 ? pad + innerW / 2 : pad + (i / (n - 1)) * innerW;

  // Y mapped from value range; flat line (mid) when all equal or single point.
  const min = n ? Math.min(...points) : 0;
  const max = n ? Math.max(...points) : 0;
  const span = max - min;
  const yAt = (v: number) =>
    span === 0 ? pad + innerH / 2 : pad + (1 - (v - min) / span) * innerH;

  const coords = points.map((v, i) => [xAt(i), yAt(v)] as const);
  const linePts = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const last = coords[coords.length - 1];

  // Area polygon: line points, then drop to baseline and close.
  const baseline = h - pad;
  const areaPts =
    coords.length > 0
      ? `${linePts} ${xAt(n - 1).toFixed(2)},${baseline.toFixed(2)} ${xAt(0).toFixed(
          2,
        )},${baseline.toFixed(2)}`
      : "";

  return (
    <svg
      data-testid={testId ?? "sparkline"}
      data-points={n}
      role="img"
      aria-label={ariaLabel ?? `trend, ${n} points`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      style={{ display: "block", overflow: "visible" }}
    >
      {area && coords.length > 0 && (
        <>
          <defs>
            <linearGradient id={`spark-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.28} />
              <stop offset="100%" stopColor={accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon
            data-testid="sparkline-area"
            points={areaPts}
            fill={`url(#spark-${gradId})`}
            stroke="none"
          />
        </>
      )}
      {coords.length > 0 && (
        <polyline
          data-testid="sparkline-line"
          points={linePts}
          fill="none"
          stroke={accent}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {showLastDot && last && (
        <circle
          data-testid="sparkline-dot"
          cx={last[0]}
          cy={last[1]}
          r={Math.max(strokeWidth + 0.5, 2)}
          fill={accent}
        />
      )}
    </svg>
  );
}

export default Sparkline;
