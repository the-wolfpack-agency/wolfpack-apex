"use client";

/**
 * SavingsTrendChart — daily savings trajectory rendered as an inline SVG
 * line chart with two series:
 *
 *   • tokens_saved per day (green, left axis semantics)
 *   • cache_hits per day  (info-blue, same axis — values are independent
 *     so we render them on a single normalized axis where each series
 *     scales to its own max; tooltips show absolute counts)
 *
 * No external chart library — everything is hand-rolled SVG so the
 * Vercel bundle stays small and we don't add a runtime dep that the
 * platform directive prohibits without justification.
 *
 * Hover on a date column reveals a vertical guide line and a tooltip
 * pinned next to the data points. Mouse-leave clears it. Pure SVG +
 * a tiny piece of state — no D3, no recharts.
 *
 * Empty state: when daily_trend is empty the chart renders a friendly
 * placeholder rather than 0-height SVG that would collapse the layout.
 */

import { useMemo, useState } from "react";

export interface DailyTrendPoint {
  date: string;
  tokens_saved: number;
  ai_calls: number;
  cache_hits: number;
}

export interface SavingsTrendChartProps {
  data: DailyTrendPoint[];
}

const NUM = new Intl.NumberFormat("en-US");

/* Chart dimensions — viewBox space, scales responsively via width=100%. */
const CHART_W = 800;
const CHART_H = 220;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

const TOKEN_COLOR = "rgb(120,210,150)"; // savings green
const HITS_COLOR = "rgb(140,185,235)"; // info blue

interface SeriesPoint {
  x: number;
  y: number;
  raw: number;
}

function buildSeries(values: number[]): SeriesPoint[] {
  const max = Math.max(1, ...values); // avoid /0 when all zero
  const step = values.length > 1 ? PLOT_W / (values.length - 1) : 0;
  return values.map((v, i) => {
    const norm = v / max;
    return {
      x: PAD_L + i * step,
      y: PAD_T + PLOT_H - norm * PLOT_H,
      raw: v,
    };
  });
}

function pathFor(points: SeriesPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 1} ${p.y}`;
  }
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
}

/** "Apr 18" — short month + day, locale-independent stable rendering. */
function formatTickLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SavingsTrendChart({ data }: SavingsTrendChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const tokenSeries = useMemo(
    () => buildSeries(data.map((d) => d.tokens_saved || 0)),
    [data],
  );
  const hitsSeries = useMemo(
    () => buildSeries(data.map((d) => d.cache_hits || 0)),
    [data],
  );

  if (data.length === 0) {
    return (
      <section
        data-testid="savings-trend-chart"
        aria-label="Daily savings trend"
        style={{
          background: "var(--wp-card, var(--wp-dark-surface))",
          border: "1px solid var(--wp-border, var(--wp-dark-border))",
          borderRadius: 8,
          padding: "1.4rem",
          marginBottom: "1.4rem",
          color: "var(--wp-text-dim)",
        }}
      >
        <div data-testid="savings-trend-chart-empty">
          No daily activity yet. Trend will fill in as tickets are
          processed.
        </div>
      </section>
    );
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    /* Translate client X to viewBox X (CHART_W) so hover index maps
       correctly even when the SVG is responsively scaled. */
    const localX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    if (localX < PAD_L || localX > CHART_W - PAD_R) {
      setHoverIdx(null);
      return;
    }
    /* Find nearest data index on the X axis. */
    const step = data.length > 1 ? PLOT_W / (data.length - 1) : 0;
    const idx = step > 0
      ? Math.round((localX - PAD_L) / step)
      : 0;
    const clamped = Math.max(0, Math.min(data.length - 1, idx));
    setHoverIdx(clamped);
  };

  const hover = hoverIdx !== null ? data[hoverIdx] : null;
  const hoverX =
    hoverIdx !== null && tokenSeries[hoverIdx]
      ? tokenSeries[hoverIdx].x
      : null;

  return (
    <section
      data-testid="savings-trend-chart"
      aria-label="Daily savings trend"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1.1rem 1.2rem",
        marginBottom: "1.4rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.6rem",
          marginBottom: "0.6rem",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "1rem",
            fontWeight: 600,
            color: "var(--wp-text)",
          }}
        >
          Daily savings trajectory
        </h2>
        <div
          style={{
            display: "flex",
            gap: "0.9rem",
            fontSize: "0.78rem",
            color: "var(--wp-text-dim)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                background: TOKEN_COLOR,
                borderRadius: 2,
                display: "inline-block",
              }}
            />
            Tokens saved
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                background: HITS_COLOR,
                borderRadius: 2,
                display: "inline-block",
              }}
            />
            Cache hits
          </span>
        </div>
      </header>

      <div style={{ position: "relative" }}>
        <svg
          data-testid="savings-trend-chart-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width="100%"
          height={CHART_H}
          role="img"
          aria-label="Line chart showing tokens saved and cache hits per day"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
          style={{ display: "block", touchAction: "manipulation" }}
        >
          {/* Plot frame */}
          <rect
            x={PAD_L}
            y={PAD_T}
            width={PLOT_W}
            height={PLOT_H}
            fill="transparent"
            stroke="var(--wp-border, var(--wp-dark-border))"
            strokeOpacity={0.4}
          />

          {/* Horizontal gridlines (4 bands). */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={PAD_L}
              x2={CHART_W - PAD_R}
              y1={PAD_T + PLOT_H * f}
              y2={PAD_T + PLOT_H * f}
              stroke="var(--wp-border, var(--wp-dark-border))"
              strokeOpacity={0.2}
              strokeDasharray="3 4"
            />
          ))}

          {/* Tokens-saved line + points */}
          <path
            d={pathFor(tokenSeries)}
            fill="none"
            stroke={TOKEN_COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {tokenSeries.map((p, i) => (
            <circle
              key={`t-${i}`}
              data-testid={`trend-point-tokens-${i}`}
              cx={p.x}
              cy={p.y}
              r={hoverIdx === i ? 4 : 2.5}
              fill={TOKEN_COLOR}
            />
          ))}

          {/* Cache-hits line + points */}
          <path
            d={pathFor(hitsSeries)}
            fill="none"
            stroke={HITS_COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="4 3"
          />
          {hitsSeries.map((p, i) => (
            <circle
              key={`h-${i}`}
              data-testid={`trend-point-hits-${i}`}
              cx={p.x}
              cy={p.y}
              r={hoverIdx === i ? 4 : 2.5}
              fill={HITS_COLOR}
            />
          ))}

          {/* Hover guide line */}
          {hoverX !== null && (
            <line
              data-testid="trend-hover-guide"
              x1={hoverX}
              x2={hoverX}
              y1={PAD_T}
              y2={PAD_T + PLOT_H}
              stroke="var(--wp-text-dim)"
              strokeOpacity={0.5}
              strokeDasharray="2 3"
            />
          )}

          {/* X-axis labels — first, middle, last for readability at any width */}
          {data.map((d, i) => {
            const showLabel =
              i === 0 ||
              i === data.length - 1 ||
              (data.length > 4 && i === Math.floor(data.length / 2));
            if (!showLabel) return null;
            const x =
              tokenSeries[i]?.x ?? PAD_L + (i * PLOT_W) / Math.max(1, data.length - 1);
            return (
              <text
                key={`x-${i}`}
                x={x}
                y={CHART_H - 10}
                textAnchor="middle"
                fontSize="11"
                fill="var(--wp-text-dim)"
              >
                {formatTickLabel(d.date)}
              </text>
            );
          })}
        </svg>

        {/* Tooltip — positioned in DOM space using % of CHART_W so it
            tracks the SVG when it's responsively scaled. */}
        {hover && hoverX !== null && (
          <div
            data-testid="trend-hover-tooltip"
            role="tooltip"
            style={{
              position: "absolute",
              left: `calc(${(hoverX / CHART_W) * 100}% + 8px)`,
              top: 8,
              background: "var(--wp-dark-surface, #1a1a1d)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              padding: "0.5rem 0.7rem",
              fontSize: "0.78rem",
              color: "var(--wp-text)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {formatTickLabel(hover.date)}
            </div>
            <div style={{ color: TOKEN_COLOR }}>
              Tokens saved: {NUM.format(hover.tokens_saved || 0)}
            </div>
            <div style={{ color: HITS_COLOR }}>
              Cache hits: {NUM.format(hover.cache_hits || 0)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
