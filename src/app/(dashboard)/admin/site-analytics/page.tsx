"use client";

/**
 * Admin Site Analytics — where and when ogiam.com is being used, on our own
 * infrastructure (no third-party analytics product). Reads the aggregated
 * summary from /api/admin/site-analytics and renders the REUSED HourHeatmap
 * (time of day) plus top pages and top countries. Gated by analytics.view.
 *
 * All fetches go through fetchWithRefresh (15-min access TTL) per repo policy.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { HourHeatmap } from "@/components/HourHeatmap";

interface Summary {
  rangeDays: number;
  totalPageViews: number;
  totalEvents: number;
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
}

const RANGES = [7, 30, 90] as const;

export default function SiteAnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async (range: number) => {
    setState("loading");
    try {
      const res = await fetchWithRefresh(`/api/admin/site-analytics?days=${range}`);
      if (!res.ok) {
        setState("error");
        return;
      }
      const body = (await res.json()) as { summary: Summary };
      setSummary(body.summary);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const card: React.CSSProperties = {
    background: "var(--wp-dark-surface, #1f1f22)",
    border: "1px solid var(--wp-dark-border, #333)",
    borderRadius: 8,
    padding: "1.1rem 1.2rem",
  };
  const label: React.CSSProperties = {
    fontSize: "0.72rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "var(--wp-text-muted, #9ca3af)",
  };

  return (
    <div data-testid="site-analytics-page" style={{ display: "grid", gap: "1.25rem", maxWidth: 920 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
            Site Analytics
          </h1>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "var(--wp-text-muted, #9ca3af)" }}>
            Where and when ogiam.com is used. Our own data, no third-party analytics.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`range-${r}`}
              onClick={() => setDays(r)}
              style={{
                padding: "0.35rem 0.7rem",
                borderRadius: 6,
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                background: days === r ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface2, #1a1a1a)",
                color: days === r ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                border: "1px solid var(--wp-gold, #e8b528)",
              }}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {state === "loading" && (
        <div data-testid="site-analytics-loading" style={{ ...card, color: "var(--wp-text-muted, #9ca3af)" }}>
          Loading…
        </div>
      )}
      {state === "error" && (
        <div data-testid="site-analytics-error" style={{ ...card, color: "var(--wp-error, #ef4444)" }}>
          Could not load site analytics right now.
        </div>
      )}

      {state === "ready" && summary && (
        <>
          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
            <div style={card}>
              <div style={label}>Page views ({summary.rangeDays}d)</div>
              <div data-testid="total-page-views" style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                {summary.totalPageViews.toLocaleString()}
              </div>
            </div>
            <div style={card}>
              <div style={label}>Total events</div>
              <div style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                {summary.totalEvents.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Heatmap (reused) */}
          <div style={card}>
            <div style={label}>Page views by hour of day (UTC)</div>
            <div style={{ marginTop: "0.8rem" }}>
              <HourHeatmap data={summary.byHour} testIdPrefix="site-hour" unitLabel="view" />
            </div>
            {summary.totalPageViews === 0 && (
              <p data-testid="site-analytics-empty" style={{ marginTop: "0.7rem", fontSize: "0.78rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                No page views recorded in this window yet.
              </p>
            )}
          </div>

          {/* Top pages + countries */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
            <div style={card}>
              <div style={label}>Top pages</div>
              <ul data-testid="top-pages" style={{ listStyle: "none", margin: "0.6rem 0 0", padding: 0, display: "grid", gap: "0.35rem" }}>
                {summary.byPage.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byPage.map((p) => (
                  <li key={p.path} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</span>
                    <span style={{ color: "var(--wp-text-muted, #9ca3af)" }}>{p.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div style={card}>
              <div style={label}>Top countries</div>
              <ul data-testid="top-countries" style={{ listStyle: "none", margin: "0.6rem 0 0", padding: 0, display: "grid", gap: "0.35rem" }}>
                {summary.byCountry.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byCountry.map((c) => (
                  <li key={c.country} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span>{c.country}</span>
                    <span style={{ color: "var(--wp-text-muted, #9ca3af)" }}>{c.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
