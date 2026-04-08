"use client";

import { useEffect, useState } from "react";
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

export function InsightsTab() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/people/insights", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setInsights(d.insights ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>;

  return (
    <div data-tab="insights">
      <h3 style={{ fontSize: "1.05rem", margin: "0 0 1rem" }}>Insights ({insights.length})</h3>
      {insights.length === 0 ? (
        <div style={{ padding: "2rem", textAlign: "center", border: "1px dashed var(--wp-border)", borderRadius: "8px", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
          No insights yet. Upload a benefits PDF in the Benefits tab to generate insights automatically.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {insights.map((i) => (
            <div
              key={i.id}
              data-insight={i.id}
              style={{
                padding: "0.85rem 1rem",
                background: "var(--wp-card)",
                borderLeft: `3px solid ${i.severity === "critical" ? "#c44" : i.severity === "attention" ? "var(--wp-warning)" : "var(--wp-info)"}`,
                borderRadius: "4px",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.25rem" }}>
                {i.category} · {i.severity}
              </div>
              <strong style={{ fontSize: "0.9rem" }}>{i.title}</strong>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>{i.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
