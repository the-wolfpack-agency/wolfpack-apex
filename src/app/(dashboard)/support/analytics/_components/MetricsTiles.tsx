"use client";

/**
 * MetricsTiles — 4-up responsive grid of headline metrics that sit
 * directly under SavingsHero. Each tile renders a label, a big number,
 * and an optional subtle hint line.
 *
 * Responsive layout: 1 column on narrow phones (<420px), 2x2 on small
 * tablets/desktop default, 1x4 on wide screens (>=960px). All driven by
 * CSS grid auto-fit so we don't need media queries to break out.
 *
 * The component formats numbers with thousands separators and renders
 * cache_hit_rate as a percentage with one decimal. time_saved_ms is
 * formatted as "Xs" / "Xm Xs" / "Xh Xm" so an operator can read it at
 * a glance without converting.
 */

const NUM = new Intl.NumberFormat("en-US");

export interface MetricsTilesProps {
  tokensSaved: number;
  cacheHitRate: number; // 0..1
  aiCalls: number;
  timeSavedMs: number;
}

/** Human-friendly time formatter. 0–60s → "Xs", up to 1h → "Xm Xs",
 *  beyond → "Xh Xm". Returns "0s" for 0 / negative / NaN so the tile
 *  always has SOMETHING to render. */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0 || Number.isNaN(ms)) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Format a 0..1 ratio as "XX.X%". Clamps to [0,100] for safety. */
export function formatPercent(rate: number): string {
  if (!rate || Number.isNaN(rate)) return "0.0%";
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  return `${pct.toFixed(1)}%`;
}

interface TileProps {
  testId: string;
  label: string;
  value: string;
  hint?: string;
  /** Color token for the value text — green for savings, info for cache,
   *  gold for general headline numbers. */
  tone?: "good" | "info" | "gold" | "neutral";
}

function Tile({ testId, label, value, hint, tone = "neutral" }: TileProps) {
  const valueColor =
    tone === "good"
      ? "rgb(120,210,150)"
      : tone === "info"
        ? "rgb(140,185,235)"
        : tone === "gold"
          ? "var(--wp-gold)"
          : "var(--wp-text)";

  return (
    <div
      data-testid={testId}
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1rem 1.1rem",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: "0.78rem",
          color: "var(--wp-text-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          fontWeight: 600,
          marginBottom: "0.4rem",
        }}
      >
        {label}
      </div>
      <div
        data-testid={`${testId}-value`}
        style={{
          fontSize: "1.7rem",
          fontWeight: 700,
          color: valueColor,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {hint && (
        <div
          style={{
            marginTop: "0.3rem",
            fontSize: "0.78rem",
            color: "var(--wp-text-dim)",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

export default function MetricsTiles({
  tokensSaved,
  cacheHitRate,
  aiCalls,
  timeSavedMs,
}: MetricsTilesProps) {
  return (
    <section
      data-testid="metrics-tiles"
      aria-label="AI savings metrics"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "0.75rem",
        marginBottom: "1.4rem",
      }}
    >
      <Tile
        testId="metric-tile-tokens-saved"
        label="Tokens saved"
        value={NUM.format(Math.max(0, tokensSaved || 0))}
        hint="Reused via cache"
        tone="good"
      />
      <Tile
        testId="metric-tile-cache-hit-rate"
        label="Cache hit rate"
        value={formatPercent(cacheHitRate)}
        hint="Higher is better"
        tone="info"
      />
      <Tile
        testId="metric-tile-ai-calls"
        label="AI calls"
        value={NUM.format(Math.max(0, aiCalls || 0))}
        hint="Total in window"
        tone="gold"
      />
      <Tile
        testId="metric-tile-time-saved"
        label="Time saved"
        value={formatDuration(timeSavedMs)}
        hint="Operator wait avoided"
        tone="good"
      />
    </section>
  );
}
