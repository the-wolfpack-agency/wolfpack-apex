/**
 * Agent intelligence panel: cross-site campaigns, the automation/AI/script mix,
 * and who adapted after a block. Presentational; reads only the agentIntel slice.
 */
import { card, label } from "@/components/site-analytics/styles";

export interface AgentIntelData {
  operators: number;
  campaigns: number;
  automationFleet: number;
  aiAgents: number;
  scripts: number;
  datacenterOperators?: number;
  persistedAfterBlock: number;
  escalatedAfterBlock: number;
  topCampaigns: Array<{ fp: string; sites: string[]; clientClass: string; rhythm: string }>;
}

export function AgentIntelPanel({ data }: { data: AgentIntelData }) {
  return (
            <details className="ff-collapse" style={card} data-testid="ff-agent-intel">
              <summary>
                <span style={label}>Agent intelligence &middot; who these agents really are</span>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {data.operators.toLocaleString()} operators <span className="ff-chev">&#9656;</span>
                </span>
              </summary>
              <div style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #9ca3af)", marginTop: "0.35rem", lineHeight: 1.5 }}>
                Deeper profiling of the {data.operators.toLocaleString()} distinct operators seen: the same fingerprint across properties is one coordinated campaign, and the client mix shows what is actually reaching you.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "1rem", marginTop: "0.8rem" }}>
                {[
                  { k: "Cross-site campaigns", v: data.campaigns, c: "var(--wp-error, #ef4444)", t: "intel-campaigns" },
                  { k: "Automation fleet", v: data.automationFleet, c: "var(--wp-warning, #f5a623)", t: "intel-automation" },
                  { k: "Datacenter-hosted", v: data.datacenterOperators ?? 0, c: "var(--wp-error, #ef4444)", t: "intel-datacenter" },
                  { k: "AI agents", v: data.aiAgents, c: "var(--wp-gold, #e8b528)", t: "intel-ai" },
                  { k: "Scripts", v: data.scripts, c: "var(--wp-text-muted, #9ca3af)", t: "intel-scripts" },
                  { k: "Persisted after block", v: data.persistedAfterBlock, c: "var(--wp-error, #ef4444)", t: "intel-persisted" },
                  { k: "Escalated after block", v: data.escalatedAfterBlock, c: "var(--wp-error, #ef4444)", t: "intel-escalated" },
                ].map((m) => (
                  <div key={m.k}>
                    <div style={{ ...label, color: m.c }}>{m.k}</div>
                    <div data-testid={m.t} style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>{m.v.toLocaleString()}</div>
                  </div>
                ))}
              </div>
              {data.topCampaigns.length > 0 && (
                <div style={{ marginTop: "1rem" }}>
                  <div style={label}>Coordinated campaigns (one operator, multiple properties)</div>
                  <ul data-testid="intel-top-campaigns" style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0, display: "grid", gap: "0.4rem" }}>
                    {data.topCampaigns.map((c) => (
                      <li key={c.fp} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.82rem", color: "var(--wp-text, #eee)", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", color: "var(--wp-text-muted, #b8bcc4)" }}>{c.fp} &middot; {c.clientClass.replace(/_/g, " ")} &middot; {c.rhythm.replace(/_/g, " ")}</span>
                        <span style={{ color: "var(--wp-error, #ef4444)" }}>{c.sites.join(" + ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
  );
}
