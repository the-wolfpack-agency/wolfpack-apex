"use client";

import { fetchWithRefresh } from "@/lib/client-auth";

import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "./auth";

interface Insight {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  status: string;
  created_at: string;
}

/**
 * Category → Human-friendly group label. The API emits raw category
 * strings from the insight generators (benefits/compliance/onboarding
 * today; performance/retention/engagement/compensation as HR features
 * grow). This map collapses each into a user-facing bucket so Alicia
 * sees groups, not a data dump.
 *
 * Unknown / future categories fall through to `titleCase(category)` so
 * we never silently hide an insight.
 */
const CATEGORY_GROUP: Record<string, string> = {
  // Benefits-side insights (costs, plan comparisons, renewals).
  benefits: "Benefits",
  compensation: "Compensation",
  payroll: "Compensation",
  // Onboarding funnel (stalled steps, missing docs).
  onboarding: "Onboarding",
  // Retention / engagement signals (tenure gaps, survey deltas).
  retention: "Retention",
  engagement: "Engagement",
  performance: "Performance",
  // Compliance / document quality — I-9s, W-4s, PII, audit.
  compliance: "Compliance & Documents",
  documents: "Compliance & Documents",
  pii: "Compliance & Documents",
  security: "Compliance & Documents",
  quality: "Compliance & Documents",
};

/**
 * Stable sort order for groups. Keeps the headings in a predictable
 * reading flow regardless of how many insights land in each bucket.
 */
const GROUP_ORDER: string[] = [
  "Engagement",
  "Retention",
  "Performance",
  "Compensation",
  "Benefits",
  "Onboarding",
  "Compliance & Documents",
];

function titleCase(s: string): string {
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function groupLabel(category: string): string {
  return CATEGORY_GROUP[category] ?? titleCase(category);
}

function severityColor(sev: string): string {
  if (sev === "critical") return "#c44";
  if (sev === "attention") return "var(--wp-warning)";
  return "var(--wp-info)";
}

interface GroupedInsights {
  label: string;
  items: Insight[];
}

export function groupInsights(insights: Insight[]): GroupedInsights[] {
  const buckets = new Map<string, Insight[]>();
  for (const ins of insights) {
    const label = groupLabel(ins.category);
    const list = buckets.get(label) ?? [];
    list.push(ins);
    buckets.set(label, list);
  }
  const present = Array.from(buckets.keys());
  const ordered = [
    ...GROUP_ORDER.filter((g) => buckets.has(g)),
    ...present.filter((g) => !GROUP_ORDER.includes(g)).sort(),
  ];
  return ordered.map((label) => ({
    label,
    items: buckets.get(label) ?? [],
  }));
}

export function InsightsTab() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  // Map of group-label → expanded? Defaults: first group open, rest closed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchWithRefresh("/api/people/insights", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setInsights(d.insights ?? []))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => groupInsights(insights), [insights]);

  // Initialize expansion once groups are computed: first group open,
  // all subsequent groups collapsed. Subsequent state changes come
  // from the user toggling headers.
  useEffect(() => {
    if (groups.length === 0) return;
    setExpanded((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const init: Record<string, boolean> = {};
      groups.forEach((g, i) => {
        init[g.label] = i === 0;
      });
      return init;
    });
    // Fire analytics on the grouped view so the learning loop sees
    // how Alicia actually browses the insights list.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        event: "hr.insights.grouped_view",
        metadata: {
          group_count: groups.length,
          insight_count: insights.length,
        },
      }),
    }).catch(() => {});
  }, [groups, insights.length]);

  function toggleGroup(label: string, count: number) {
    setExpanded((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      // Emit only on the open transition — every open is a learning signal.
      if (!prev[label]) {
        fetchWithRefresh("/api/analytics", {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({
            event: "hr.insights.group_expanded",
            metadata: { category: label, count },
          }),
        }).catch(() => {});
      }
      return next;
    });
  }

  if (loading) return <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>;

  return (
    <div data-tab="insights">
      <h3 style={{ fontSize: "1.05rem", margin: "0 0 1rem" }}>
        Insights ({insights.length})
      </h3>
      {insights.length === 0 ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
            fontSize: "0.85rem",
          }}
        >
          No insights yet. Upload a benefits PDF in the Benefits tab to generate insights automatically.
        </div>
      ) : (
        <div data-testid="insights-grouped" style={{ display: "grid", gap: "0.75rem" }}>
          {groups.map((g) => {
            const isOpen = expanded[g.label] ?? false;
            return (
              <section
                key={g.label}
                data-group={g.label}
                data-open={isOpen ? "true" : "false"}
                style={{
                  border: "1px solid var(--wp-border)",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`insights-group-body-${g.label.replace(/\s+/g, "-").toLowerCase()}`}
                  onClick={() => toggleGroup(g.label, g.items.length)}
                  data-testid={`insights-group-header-${g.label.replace(/\s+/g, "-").toLowerCase()}`}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.75rem 1rem",
                    background: "var(--wp-card)",
                    border: "none",
                    color: "var(--wp-text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "0.9rem",
                    fontWeight: 600,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        transition: "transform 0.15s ease",
                        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                        color: "var(--wp-text-dim)",
                      }}
                    >
                      ▶
                    </span>
                    {g.label}
                  </span>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--wp-text-dim)",
                      fontWeight: 500,
                    }}
                  >
                    {g.items.length}
                  </span>
                </button>
                {isOpen && (
                  <div
                    id={`insights-group-body-${g.label.replace(/\s+/g, "-").toLowerCase()}`}
                    style={{
                      display: "grid",
                      gap: "0.5rem",
                      padding: "0.5rem 0.75rem 0.85rem",
                      background: "var(--wp-card)",
                    }}
                  >
                    {g.items.map((i) => (
                      <div
                        key={i.id}
                        data-insight={i.id}
                        style={{
                          padding: "0.75rem 0.85rem",
                          background: "var(--wp-dark-surface, var(--wp-card))",
                          borderLeft: `3px solid ${severityColor(i.severity)}`,
                          borderRadius: "4px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--wp-text-dim)",
                            textTransform: "uppercase",
                            letterSpacing: "0.1em",
                            marginBottom: "0.25rem",
                          }}
                        >
                          {i.category} · {i.severity}
                        </div>
                        <strong style={{ fontSize: "0.9rem" }}>{i.title}</strong>
                        <p
                          style={{
                            margin: "0.25rem 0 0",
                            fontSize: "0.85rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          {i.body}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
