"use client";

/**
 * "Where humans are still needed" - the automation backlog. Reads the factory's
 * terminal ci-fix outcomes and shows the autonomy rate plus escalations ranked by
 * class (the ranked list of what to automate next). This is how dogfooding surfaces
 * its own gaps instead of a human noticing them by hand.
 */
import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader, StatusPill } from "@/components/console";

interface Backlog {
  total: number;
  autonomous: number;
  escalated: number;
  autonomyRate: number;
  byClass: Array<{ class: string; count: number }>;
  recent: Array<{ repo: string; ref: string; class: string; reason: string; createdAt: string }>;
}

const CLASS_LABEL: Record<string, string> = {
  governance: "Governance gate",
  ambiguous_spec: "Ambiguous spec",
  infra_no_detail: "Infra / no error detail",
  preexisting_only: "Pre-existing red only",
  lint: "Lint / format",
  type: "Type error",
  build: "Build",
  snapshot: "Snapshot",
  other: "Other",
};
const label = (c: string): string => CLASS_LABEL[c] ?? c;

export default function BacklogPanel() {
  const [data, setData] = useState<Backlog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/admin/ai-code/backlog?days=30");
        if (live && res.ok) setData((await res.json()).backlog as Backlog);
      } catch {
        /* leave data null -> empty state */
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <GlassPanel>
      <SectionHeader
        title="Where humans are still needed"
        subtitle="Automation backlog from the factory's own outcomes, last 30 days"
      />
      {loading ? (
        <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>Loading…</p>
      ) : !data || data.total === 0 ? (
        <p style={{ opacity: 0.6, fontSize: "0.85rem" }}>
          No terminal ci-fix outcomes recorded yet. As the factory resolves PRs, autonomous wins and
          human escalations appear here.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <MetricTile label="Autonomy rate" display={`${Math.round(data.autonomyRate * 100)}%`} />
            <MetricTile label="Resolved autonomously" display={String(data.autonomous)} />
            <MetricTile label="Escalated to a human" display={String(data.escalated)} />
          </div>

          {data.byClass.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.8rem", opacity: 0.7, marginBottom: "0.4rem" }}>
                Escalations by cause (what to automate next)
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.35rem" }}>
                {data.byClass.map((c) => (
                  <li key={c.class} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                    <span>{label(c.class)}</span>
                    <StatusPill status={String(c.count)} tone="warning" label={String(c.count)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.recent.length > 0 && (
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7, marginBottom: "0.4rem" }}>Recent escalations</div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
                {data.recent.slice(0, 8).map((r, i) => (
                  <li key={`${r.ref}-${i}`} style={{ fontSize: "0.82rem" }}>
                    <span style={{ opacity: 0.6 }}>{r.repo}</span> <strong>{r.ref}</strong>{" "}
                    <span style={{ opacity: 0.5 }}>· {label(r.class)}</span>
                    <div style={{ opacity: 0.7 }}>{r.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </GlassPanel>
  );
}
