"use client";

/**
 * /support/analytics — operator-facing dashboard for the AI savings the
 * support pipeline is delivering. The page answers six questions on a
 * single screen:
 *
 *   1. How much money has the cache saved this period? (hero)
 *   2. Is the cache hit rate trending in the right direction? (tile)
 *   3. Which support features benefit most from the cache? (per-feature)
 *   4. Where are the AI dollars going by provider? (per-provider)
 *   5. Which cached responses are doing the heaviest lifting? (top-cached)
 *   6. What does the daily savings curve look like? (trend chart)
 *
 * Auth: redirects unauthenticated visitors to /login?next=/support/analytics
 * BEFORE rendering, per the dashboard convention. Never renders an empty
 * 200 page when the user has no token — that pattern caused the April 16
 * blank-dashboard incident and is explicitly called out in CLAUDE.md.
 *
 * Data: GET /api/support/analytics?window={today|7d|30d|all} — see the
 * AnalyticsResponse type below for the contract. Window changes re-fetch
 * (the request runs through fetchWithRefresh, never raw fetch).
 *
 * Errors: when the server returns errors[] non-empty, we render the
 * available sections plus a banner instructing a refresh — partial
 * data is more useful than a stop sign.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import SavingsHero from "./_components/SavingsHero";
import MetricsTiles from "./_components/MetricsTiles";
import SavingsTrendChart, {
  type DailyTrendPoint,
} from "./_components/SavingsTrendChart";

// ---------------------------------------------------------------------------
// API contract — mirrors the spec the parallel backend agent is delivering.
// ---------------------------------------------------------------------------

export type AnalyticsWindow = "today" | "7d" | "30d" | "all";

interface SummaryShape {
  tokens_saved: number;
  ai_calls: number;
  cache_hits: number;
  cache_miss: number;
  cache_hit_rate: number; // 0..1
  cost_saved_usd: number;
  time_saved_ms: number;
  period: { start: string; end: string };
}

interface ByFeatureRow {
  feature: string;
  cache_hits: number;
  cache_miss: number;
  tokens_saved: number;
  hit_rate: number;
}

interface ByProviderRow {
  provider: string;
  calls: number;
  tokens: number;
  cost_usd: number;
  tokens_saved?: number;
  cost_saved_usd?: number;
}

interface TopCachedRow {
  id: string;
  feature: string;
  hit_count: number;
  helpful_count: number;
  unhelpful_count: number;
  tokens_saved_estimate: number;
  model_used: string;
  last_used_at: string;
  prompt_preview: string;
}

interface AnalyticsResponse {
  summary: SummaryShape;
  by_feature: ByFeatureRow[];
  by_provider: ByProviderRow[];
  top_cached: TopCachedRow[];
  daily_trend: DailyTrendPoint[];
  errors: string[];
}

const WINDOW_OPTIONS: { key: AnalyticsWindow; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];

const NUM = new Intl.NumberFormat("en-US");
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

/** Plain-language relative time. Mirrors formatTimeAgo in TicketList so
 *  the visual rhythm stays consistent across surfaces. */
export function formatRelativeTime(ts?: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function emptyAnalytics(): AnalyticsResponse {
  return {
    summary: {
      tokens_saved: 0,
      ai_calls: 0,
      cache_hits: 0,
      cache_miss: 0,
      cache_hit_rate: 0,
      cost_saved_usd: 0,
      time_saved_ms: 0,
      period: { start: "", end: "" },
    },
    by_feature: [],
    by_provider: [],
    top_cached: [],
    daily_trend: [],
    errors: [],
  };
}

export default function SupportAnalyticsPage() {
  const [windowKey, setWindowKey] = useState<AnalyticsWindow>("7d");
  const [data, setData] = useState<AnalyticsResponse>(emptyAnalytics);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const load = useCallback(async (w: AnalyticsWindow) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/support/analytics?window=${encodeURIComponent(w)}`,
      );
      if (!res.ok) {
        setError(
          "We couldn't load AI savings analytics right now. Refresh the page in a moment.",
        );
        return;
      }
      const json = (await res.json()) as Partial<AnalyticsResponse>;
      /* Normalize: the server may omit empty arrays for sections it had
         no data for. Default everything so the UI never crashes on a
         malformed response shape. */
      setData({
        summary: { ...emptyAnalytics().summary, ...(json.summary ?? {}) },
        by_feature: Array.isArray(json.by_feature) ? json.by_feature : [],
        by_provider: Array.isArray(json.by_provider) ? json.by_provider : [],
        top_cached: Array.isArray(json.top_cached) ? json.top_cached : [],
        daily_trend: Array.isArray(json.daily_trend) ? json.daily_trend : [],
        errors: Array.isArray(json.errors) ? json.errors : [],
      });
    } catch (err) {
      setError(
        `Something went wrong loading analytics: ${(err as Error).message}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    void load(windowKey);
  }, [authChecked, windowKey, load]);

  const isEmptyWindow = useMemo(() => {
    if (loading || error) return false;
    return (
      data.summary.ai_calls === 0 &&
      data.daily_trend.length === 0 &&
      data.by_feature.length === 0 &&
      data.by_provider.length === 0 &&
      data.top_cached.length === 0
    );
  }, [data, loading, error]);

  if (!authChecked) {
    return null;
  }

  return (
    <main
      data-testid="support-analytics-page"
      style={{
        padding: "2rem",
        maxWidth: 1100,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.4rem",
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ margin: 0, fontSize: "1.8rem" }}>
            AI savings analytics
          </h1>
          <p
            style={{
              marginTop: "0.4rem",
              marginBottom: 0,
              color: "var(--wp-text-dim)",
              maxWidth: "62ch",
              lineHeight: 1.45,
            }}
          >
            How much the cache, the prompt library, and the AI draft pipeline
            are saving on tokens, dollars, and operator time. Pick a window
            to see savings over today, the last week, the last month, or all
            time.
          </p>
        </div>
        <Link
          href="/support"
          data-testid="support-analytics-back"
          style={{
            background: "transparent",
            color: "var(--wp-text-dim)",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            padding: "0.55rem 1rem",
            borderRadius: 6,
            fontWeight: 500,
            fontSize: "0.88rem",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Back to tickets
        </Link>
      </header>

      <div
        role="tablist"
        aria-label="Window"
        data-testid="support-analytics-window-pills"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "1.2rem",
        }}
      >
        {WINDOW_OPTIONS.map((w) => {
          const active = windowKey === w.key;
          return (
            <button
              key={w.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`support-analytics-window-${w.key}`}
              data-active={active ? "yes" : "no"}
              onClick={() => setWindowKey(w.key)}
              style={{
                background: active
                  ? "rgba(241,194,51,0.18)"
                  : "var(--wp-card, var(--wp-dark-surface))",
                color: active ? "var(--wp-gold)" : "var(--wp-text)",
                border: `1px solid ${active ? "var(--wp-gold)" : "var(--wp-border, var(--wp-dark-border))"}`,
                borderRadius: 999,
                padding: "0.4rem 0.9rem",
                fontSize: "0.85rem",
                fontWeight: 600,
                cursor: "pointer",
                touchAction: "manipulation",
              }}
            >
              {w.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          data-testid="support-analytics-error"
          role="alert"
          style={{
            padding: "0.7rem 0.9rem",
            background: "rgba(232,123,123,0.10)",
            border: "1px solid rgba(232,123,123,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            color: "var(--wp-text)",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {!error && data.errors.length > 0 && (
        <div
          data-testid="support-analytics-partial-error"
          role="alert"
          style={{
            padding: "0.7rem 0.9rem",
            background: "rgba(229,180,69,0.10)",
            border: "1px solid rgba(229,180,69,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            color: "var(--wp-text)",
            marginBottom: "1rem",
          }}
        >
          Some sections couldn&apos;t load. Refresh to retry.
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : isEmptyWindow ? (
        <div
          data-testid="support-analytics-empty"
          style={{
            padding: "1.6rem",
            background: "var(--wp-card, var(--wp-dark-surface))",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            borderRadius: 8,
            color: "var(--wp-text-dim)",
            maxWidth: 640,
          }}
        >
          No AI calls yet in this period. Activity will appear here as
          tickets are processed.
        </div>
      ) : (
        <>
          <SavingsHero
            costSavedUsd={data.summary.cost_saved_usd}
            aiCalls={data.summary.ai_calls}
            cacheHits={data.summary.cache_hits}
          />
          <MetricsTiles
            tokensSaved={data.summary.tokens_saved}
            cacheHitRate={data.summary.cache_hit_rate}
            aiCalls={data.summary.ai_calls}
            timeSavedMs={data.summary.time_saved_ms}
          />
          <SavingsTrendChart data={data.daily_trend} />

          <FeatureTable rows={data.by_feature} />
          <ProviderTable rows={data.by_provider} />
          <TopCachedTable rows={data.top_cached} />
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Inline tables — simple enough that pulling them out into separate files
// would only spread the page rendering across more files without giving
// us reuse. They each follow the same .table style for visual coherence.
// ---------------------------------------------------------------------------

const TABLE_STYLES: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.88rem",
};

const TH_STYLES: React.CSSProperties = {
  textAlign: "left",
  padding: "0.55rem 0.7rem",
  fontWeight: 600,
  color: "var(--wp-text-dim)",
  fontSize: "0.78rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  borderBottom: "1px solid var(--wp-border, var(--wp-dark-border))",
};

const TD_STYLES: React.CSSProperties = {
  padding: "0.55rem 0.7rem",
  borderBottom: "1px solid var(--wp-border, var(--wp-dark-border))",
  color: "var(--wp-text)",
};

function SectionShell({
  title,
  testId,
  empty,
  children,
}: {
  title: string;
  testId: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1rem 1.2rem",
        marginBottom: "1.4rem",
        overflowX: "auto",
      }}
    >
      <h2
        style={{
          margin: "0 0 0.6rem",
          fontSize: "1rem",
          fontWeight: 600,
          color: "var(--wp-text)",
        }}
      >
        {title}
      </h2>
      {empty ? (
        <div
          data-testid={`${testId}-empty`}
          style={{ color: "var(--wp-text-dim)", fontSize: "0.88rem" }}
        >
          No data for this period.
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function FeatureTable({ rows }: { rows: ByFeatureRow[] }) {
  return (
    <SectionShell
      title="Per feature"
      testId="support-analytics-by-feature"
      empty={rows.length === 0}
    >
      <table style={TABLE_STYLES}>
        <thead>
          <tr>
            <th style={TH_STYLES}>Feature</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Calls</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Hits</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Hit rate</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Tokens saved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const calls = (r.cache_hits || 0) + (r.cache_miss || 0);
            const ratePct = (Math.max(0, Math.min(1, r.hit_rate || 0)) * 100).toFixed(1);
            return (
              <tr key={`${r.feature}-${i}`} data-testid={`feature-row-${r.feature}`}>
                <td style={TD_STYLES}>{r.feature}</td>
                <td style={{ ...TD_STYLES, textAlign: "right" }}>{NUM.format(calls)}</td>
                <td style={{ ...TD_STYLES, textAlign: "right" }}>
                  {NUM.format(r.cache_hits || 0)}
                </td>
                <td
                  style={{
                    ...TD_STYLES,
                    textAlign: "right",
                    color: "rgb(140,185,235)",
                  }}
                >
                  {ratePct}%
                </td>
                <td
                  style={{
                    ...TD_STYLES,
                    textAlign: "right",
                    color: "rgb(120,210,150)",
                  }}
                >
                  {NUM.format(r.tokens_saved || 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionShell>
  );
}

function ProviderTable({ rows }: { rows: ByProviderRow[] }) {
  return (
    <SectionShell
      title="Per provider"
      testId="support-analytics-by-provider"
      empty={rows.length === 0}
    >
      <table style={TABLE_STYLES}>
        <thead>
          <tr>
            <th style={TH_STYLES}>Provider</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Calls</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Tokens</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Cost</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Savings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isCache = r.provider === "cache";
            const savings = r.cost_saved_usd ?? 0;
            return (
              <tr key={`${r.provider}-${i}`} data-testid={`provider-row-${r.provider}`}>
                <td style={TD_STYLES}>{r.provider}</td>
                <td style={{ ...TD_STYLES, textAlign: "right" }}>
                  {NUM.format(r.calls || 0)}
                </td>
                <td style={{ ...TD_STYLES, textAlign: "right" }}>
                  {NUM.format(r.tokens || 0)}
                </td>
                <td
                  style={{
                    ...TD_STYLES,
                    textAlign: "right",
                    color: isCache ? "var(--wp-text-dim)" : "var(--wp-text)",
                  }}
                >
                  {isCache ? "-" : USD.format(r.cost_usd || 0)}
                </td>
                <td
                  style={{
                    ...TD_STYLES,
                    textAlign: "right",
                    color: savings > 0 ? "rgb(120,210,150)" : "var(--wp-text-dim)",
                  }}
                >
                  {savings > 0 ? USD.format(savings) : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionShell>
  );
}

function TopCachedTable({ rows }: { rows: TopCachedRow[] }) {
  return (
    <SectionShell
      title="Top reused responses"
      testId="support-analytics-top-cached"
      empty={rows.length === 0}
    >
      <table style={TABLE_STYLES}>
        <thead>
          <tr>
            <th style={TH_STYLES}>Model</th>
            <th style={TH_STYLES}>Feature</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Hits</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Helpful</th>
            <th style={{ ...TH_STYLES, textAlign: "right" }}>Unhelpful</th>
            <th style={TH_STYLES}>Last used</th>
            <th style={TH_STYLES}>Prompt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`top-cached-row-${r.id}`}>
              <td style={{ ...TD_STYLES, whiteSpace: "nowrap" }}>{r.model_used}</td>
              <td style={TD_STYLES}>{r.feature}</td>
              <td style={{ ...TD_STYLES, textAlign: "right" }}>
                {NUM.format(r.hit_count || 0)}
              </td>
              <td
                style={{
                  ...TD_STYLES,
                  textAlign: "right",
                  color: "rgb(120,210,150)",
                }}
              >
                {NUM.format(r.helpful_count || 0)}
              </td>
              <td
                style={{
                  ...TD_STYLES,
                  textAlign: "right",
                  color: r.unhelpful_count > 0 ? "rgb(232,150,150)" : "var(--wp-text-dim)",
                }}
              >
                {NUM.format(r.unhelpful_count || 0)}
              </td>
              <td style={{ ...TD_STYLES, color: "var(--wp-text-dim)", whiteSpace: "nowrap" }}>
                {formatRelativeTime(r.last_used_at)}
              </td>
              <td
                style={{
                  ...TD_STYLES,
                  color: "var(--wp-text-dim)",
                  maxWidth: 320,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.prompt_preview}
              >
                {r.prompt_preview}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionShell>
  );
}

function LoadingSkeleton() {
  /* Mirrors the eventual shape — hero, tile row, chart, then 3 tables —
     so the layout doesn't jump when the data lands. */
  const block = (h: number) => (
    <div
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        height: h,
        marginBottom: "1.1rem",
        opacity: 0.6,
      }}
    />
  );
  return (
    <div data-testid="support-analytics-loading">
      {block(110)}
      {block(110)}
      {block(220)}
      {block(160)}
    </div>
  );
}
