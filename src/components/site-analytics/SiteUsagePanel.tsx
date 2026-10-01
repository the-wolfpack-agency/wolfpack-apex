/**
 * Site Usage panel - the audience-neutral first-party analytics for a monitored
 * property: totals, the reused hour-of-day heatmap, top pages/countries, agent
 * origin map, and the high-level Forcefield summary. Presentational and pure:
 * it reads only the usage slice of the summary (no state, no handlers), which is
 * why it was safe to lift out of the console page verbatim.
 */
import { HourHeatmap } from "@/components/HourHeatmap";
import { AgentOriginMap } from "@/components/AgentOriginMap";
import { card, label } from "@/components/site-analytics/styles";

export interface SiteUsageData {
  rangeDays: number;
  collectsPageViews?: boolean;
  totalPageViews: number;
  totalEvents: number;
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  agentOrigins?: Array<{ country: string; total: number; welcomed: number; welcomedVerified: number; flagged: number; hostile: number }>;
  forcefield: {
    welcomed: number; flagged: number; trapped: number; blocked: number;
    hostileOperators?: number; hostileEvents?: number;
    topAgents: Array<{ agent: string; count: number }>;
  };
}


export function SiteUsagePanel({ data }: { data: SiteUsageData }) {
  return (
    <>
          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
            <div style={card}>
              <div style={label}>Page views ({data.rangeDays}d)</div>
              {data.collectsPageViews === false ? (
                // This property forwards only agent observations (Forcefield
                // web shim), never a page view, so the count is structurally
                // n/a - showing 0 would read as "the tool isn't working".
                <>
                  <div data-testid="total-page-views" style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text-muted, #9ca3af)" }}>
                    n/a
                  </div>
                  <div style={{ marginTop: "0.15rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                    agent monitoring only
                  </div>
                </>
              ) : (
                <div data-testid="total-page-views" style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {data.totalPageViews.toLocaleString()}
                </div>
              )}
            </div>
            <div style={card}>
              <div style={label}>Total events</div>
              <div style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                {data.totalEvents.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Heatmap (reused) */}
          <div style={card}>
            <div style={label}>Page views by hour of day (UTC)</div>
            <div style={{ marginTop: "0.8rem" }}>
              <HourHeatmap data={data.byHour} testIdPrefix="site-hour" unitLabel="view" />
            </div>
            {data.totalPageViews === 0 && (
              <p data-testid="site-analytics-empty" style={{ marginTop: "0.7rem", fontSize: "0.78rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>
                {/* Precise signal first: a property that has never sent a page
                    view is agent-monitored by design. Fall back to the
                    events-present heuristic when the field is absent (an older
                    cached API response mid-deploy). */}
                {data.collectsPageViews === false || (data.collectsPageViews === undefined && data.totalEvents > 0)
                  ? "This property is monitored by Forcefield, which forwards AGENT traffic (bots, scanners, crawlers) - not human page views - so this chart stays empty by design. The real data for this property is the agent traffic and operators below."
                  : "No page views recorded in this window yet."}
              </p>
            )}
          </div>

          {/* Top pages + countries. Collapsed by default (native <details>) so
              they reclaim the real estate; the summary shows the count and the
              content stays in the DOM. auto-fit collapses to one column on
              narrow screens. */}
          <style>{`
            details.ff-collapse > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
            details.ff-collapse > summary::-webkit-details-marker { display: none; }
            details.ff-collapse .ff-chev { transition: transform 0.15s ease; color: var(--wp-text-muted, #9ca3af); font-size: 0.8rem; }
            details.ff-collapse[open] .ff-chev { transform: rotate(90deg); }
          `}</style>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
            <details className="ff-collapse" style={card} data-testid="top-pages-collapse">
              <summary>
                <span style={label}>Top pages</span>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {data.byPage.length} <span className="ff-chev">&#9656;</span>
                </span>
              </summary>
              <ul data-testid="top-pages" style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {data.byPage.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {data.byPage.map((p) => (
                  <li key={p.path} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{p.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
            <details className="ff-collapse" style={card} data-testid="top-countries-collapse">
              <summary>
                <span style={label}>Top countries</span>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {data.byCountry.length} <span className="ff-chev">&#9656;</span>
                </span>
              </summary>
              <ul data-testid="top-countries" style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {data.byCountry.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {data.byCountry.map((c) => (
                  <li key={c.country} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.country}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{c.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* Agent origin map: where agent traffic reached us from. */}
          <div style={card} data-testid="ff-origin-map">
            <div style={label}>Agent origins &middot; where agent traffic reaches us from</div>
            <div style={{ marginTop: "0.9rem" }}>
              <AgentOriginMap origins={data.agentOrigins ?? []} />
            </div>
          </div>

          {/* Forcefield for the Web: agent traffic across all monitored sites.
              Detection is always on; enforcement turns away proven-hostile
              traffic (honeytoken trip / live payload / blocked fingerprint). */}
          <div style={card} data-testid="ff-agent-traffic">
            <div style={label} data-testid="ff-posture">
              {data.forcefield.blocked > 0
                ? `Forcefield · agent traffic (enforcing · ${data.forcefield.blocked.toLocaleString()} blocked)`
                : "Forcefield · agent traffic (monitoring · none turned away in range)"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", marginTop: "0.8rem" }}>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Confirmed hostile</div>
                <div data-testid="ff-hostile-operators" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: (data.forcefield.hostileOperators ?? 0) > 0 ? "var(--wp-error, #ef4444)" : "var(--wp-text, #eee)" }}>
                  {(data.forcefield.hostileOperators ?? 0).toLocaleString()}
                </div>
                <div style={{ fontSize: "0.62rem", color: "var(--wp-text-muted, #9ca3af)", marginTop: "0.15rem", lineHeight: 1.35 }}>
                  operators with real tradecraft (probe / decoy / payload){(data.forcefield.hostileEvents ?? 0) > 0 ? ` · ${(data.forcefield.hostileEvents ?? 0).toLocaleString()} events` : ""}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-success, #30a46c)" }}>Agents welcomed</div>
                <div data-testid="ff-welcomed" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {data.forcefield.welcomed.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-text-muted, #9ca3af)" }}>Flagged (unconfirmed)</div>
                <div data-testid="ff-flagged" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text-muted, #9ca3af)" }}>
                  {data.forcefield.flagged.toLocaleString()}
                </div>
                <div style={{ fontSize: "0.62rem", color: "var(--wp-text-muted, #6b7280)", marginTop: "0.15rem", lineHeight: 1.35 }}>
                  weak signal: unidentified automation, mostly benign crawlers &amp; first-party traffic
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Decoy trips</div>
                <div data-testid="ff-trapped" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {data.forcefield.trapped.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Blocked (enforced)</div>
                <div data-testid="ff-blocked" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {data.forcefield.blocked.toLocaleString()}
                </div>
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <div style={label}>Top identified agents (welcome lane)</div>
              <ul data-testid="ff-top-agents" style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0, display: "grid", gap: "0.35rem" }}>
                {data.forcefield.topAgents.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No agent traffic recorded yet.</li>
                )}
                {data.forcefield.topAgents.map((a) => (
                  <li key={a.agent} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.agent}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{a.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div data-testid="forcefield-legend" style={{ marginTop: "1rem", paddingTop: "0.8rem", borderTop: "1px solid var(--wp-dark-border, #262a33)", display: "grid", gap: "0.5rem" }}>
              {[
                { term: "Welcomed", color: "var(--wp-success, #30a46c)", def: "identified good agents (search + AI crawlers) - given a welcome lane, never blocked." },
                { term: "Flagged", color: "var(--wp-warning, #f5a623)", def: "unidentified automation - a weak signal, recorded only." },
                { term: "Decoy trips", color: "var(--wp-error, #ef4444)", def: "a scraper followed an invisible, robots-disallowed honeypot link - near-certainly ignoring the rules." },
                { term: "Blocked", color: "var(--wp-error, #ef4444)", def: "requests actually turned away by enforcement - proven-hostile only (honeytoken trip, live payload, or a fingerprint/signature we already caught). Legitimate visitors are never blocked." },
              ].map((row) => (
                <div key={row.term} style={{ display: "flex", gap: "0.6rem", alignItems: "baseline", fontSize: "0.82rem", lineHeight: 1.45 }}>
                  <span style={{ flexShrink: 0, minWidth: "6.5rem", fontWeight: 800, letterSpacing: "0.02em", color: row.color, textTransform: "uppercase", fontSize: "0.72rem" }}>{row.term}</span>
                  <span style={{ color: "var(--wp-text, #d8dbe0)" }}>{row.def}</span>
                </div>
              ))}
            </div>
          </div>
    </>
  );
}
