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
  forcefield: {
    welcomed: number;
    flagged: number;
    trapped: number;
    topAgents: Array<{ agent: string; count: number }>;
  };
  journeys: Array<{
    key: string;
    confidence: "proven" | "inferred";
    behaviorClass: string;
    signals: string[];
    path: string[];
    eventCount: number;
    firstAt: string;
    lastAt: string;
    summary: string;
  }>;
}

const CLASS_LABEL: Record<string, string> = {
  benign_crawler: "Benign crawler",
  aggressive_scraper: "Aggressive scraper",
  vuln_scanner: "Vulnerability scanner",
  form_spammer: "Form spammer",
  suspicious: "Suspicious automation",
  unclassified: "Unclassified",
};
const CLASS_COLOR: Record<string, string> = {
  benign_crawler: "var(--wp-success, #30a46c)",
  aggressive_scraper: "var(--wp-error, #ef4444)",
  vuln_scanner: "var(--wp-error, #ef4444)",
  form_spammer: "var(--wp-warning, #f5a623)",
  suspicious: "var(--wp-warning, #f5a623)",
  unclassified: "var(--wp-text-muted, #9ca3af)",
};

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
          <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700, color: "var(--wp-text, #eee)", display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
            Site Analytics
            <span
              data-testid="site-analytics-scope"
              style={{
                fontSize: "0.7rem",
                fontWeight: 700,
                letterSpacing: "0.02em",
                padding: "0.15rem 0.5rem",
                borderRadius: 999,
                background: "var(--wp-gold, #e8b528)",
                color: "var(--wp-dark, #0b0d11)",
              }}
            >
              ogiam.com
            </span>
          </h1>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "var(--wp-text-muted, #9ca3af)" }}>
            This tab covers ogiam.com only: where and when it is used, and how Forcefield
            handled agent traffic. Our own data, no third-party analytics.
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

          {/* Top pages + countries. auto-fit collapses to a single column on
              narrow screens (phones) so long paths get the full width instead
              of overflowing the card and colliding with the next column. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
            <div style={card}>
              <div style={label}>Top pages</div>
              <ul data-testid="top-pages" style={{ listStyle: "none", margin: "0.6rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {summary.byPage.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byPage.map((p) => (
                  <li key={p.path} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{p.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div style={card}>
              <div style={label}>Top countries</div>
              <ul data-testid="top-countries" style={{ listStyle: "none", margin: "0.6rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {summary.byCountry.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byCountry.map((c) => (
                  <li key={c.country} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.country}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{c.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Forcefield for the Web: agent traffic on ogiam.com. Watch-first, so
              these are observed, not blocked. */}
          <div style={card} data-testid="ff-agent-traffic">
            <div style={label}>Forcefield &middot; agent traffic (watch-first, nothing blocked)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", marginTop: "0.8rem" }}>
              <div>
                <div style={{ ...label, color: "var(--wp-success, #30a46c)" }}>Agents welcomed</div>
                <div data-testid="ff-welcomed" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.welcomed.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-warning, #f5a623)" }}>Automation flagged</div>
                <div data-testid="ff-flagged" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.flagged.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Decoy trips</div>
                <div data-testid="ff-trapped" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.trapped.toLocaleString()}
                </div>
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <div style={label}>Top identified agents (welcome lane)</div>
              <ul data-testid="ff-top-agents" style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0, display: "grid", gap: "0.35rem" }}>
                {summary.forcefield.topAgents.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No agent traffic recorded yet.</li>
                )}
                {summary.forcefield.topAgents.map((a) => (
                  <li key={a.agent} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.agent}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{a.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p style={{ marginTop: "0.9rem", fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>
              Welcomed = identified good agents (search + AI crawlers). Flagged = unidentified
              automation, a weak signal recorded only. Decoy trips = a scraper followed an
              invisible, robots-disallowed honeypot link, near-certainly ignoring the rules.
            </p>
          </div>

          {/* Agent journeys: correlated sessions, each a behavior class with a
              proven/inferred confidence. Following the agent's flow across the
              surface, not just single events. */}
          <div style={card} data-testid="ff-journeys">
            <div style={label}>Agent journeys &middot; behavior across the surface</div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>
              Correlated sessions with a fused behavior class. <strong style={{ color: "var(--wp-text, #eee)" }}>Proven</strong> =
              the actor carried a correlation token (engaged a trap or a hidden field only a bot touches). <strong style={{ color: "var(--wp-text, #eee)" }}>Inferred</strong> =
              grouped by a coarse fingerprint, a likely match, not confirmed.
            </p>
            <ul data-testid="ff-journeys-list" style={{ listStyle: "none", margin: "0.9rem 0 0", padding: 0, display: "grid", gap: "0.7rem" }}>
              {summary.journeys.length === 0 && (
                <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                  No correlated agent journeys yet. Sessions appear here as ogiam.com records agent signals.
                </li>
              )}
              {summary.journeys.map((j) => (
                <li key={j.key} style={{ border: "1px solid var(--wp-dark-border, #333)", borderRadius: 6, padding: "0.7rem 0.8rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.9rem", color: CLASS_COLOR[j.behaviorClass] ?? "var(--wp-text, #eee)" }}>
                      {CLASS_LABEL[j.behaviorClass] ?? j.behaviorClass}
                    </span>
                    <span
                      style={{
                        fontSize: "0.66rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.03em",
                        padding: "0.1rem 0.4rem",
                        borderRadius: 999,
                        background: j.confidence === "proven" ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface2, #1a1a1a)",
                        color: j.confidence === "proven" ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                        border: j.confidence === "proven" ? "none" : "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      {j.confidence}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>{j.eventCount} events</span>
                  </div>
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.8rem", color: "var(--wp-text, #eee)", lineHeight: 1.5 }}>{j.summary}</p>
                  {j.path.length > 0 && (
                    <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", overflowX: "auto", whiteSpace: "nowrap" }}>
                      {j.path.join("  →  ")}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
