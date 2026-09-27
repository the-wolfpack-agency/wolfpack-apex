"use client";

/**
 * Pipeline-health instruments: a product-agnostic, plain-language read on a CI
 * pipeline (Unit tests, Code quality, Security, Build & deploy, ...), each a
 * glowing status light. MODULAR by design - the factory page renders it tied to
 * the PR it just opened, and the GitHub App renders the same component for any
 * installed repo, so "what does my pipeline say" looks identical everywhere and
 * the tool names never leak into the UI.
 *
 * Presentational only: give it a dashboard, it draws it. Fetching + categorizing
 * live in @/lib/ai-code/ci-status (also shared).
 */

export type CiStatus = "pass" | "fail" | "pending" | "absent";
export interface CiCategory {
  key: string;
  label: string;
  status: CiStatus;
  passed: number;
  failed: number;
  pending: number;
  checks: string[];
}
export interface CiDashboard {
  categories: CiCategory[];
  overall: CiStatus;
  summary: { total: number; passed: number; failed: number; pending: number };
}

export const CI_LIGHT: Record<CiStatus, { color: string; label: string }> = {
  pass: { color: "#30a46c", label: "Passed" },
  fail: { color: "#ef4444", label: "Failed" },
  pending: { color: "#f5a623", label: "Running" },
  absent: { color: "#4b5563", label: "Not run" },
};
export const CI_OVERALL: Record<CiStatus, string> = {
  pass: "All systems go",
  fail: "Attention needed",
  pending: "Running checks",
  absent: "No checks yet",
};

export default function PipelineDashboard({ dashboard }: { dashboard: CiDashboard }) {
  const overall = CI_LIGHT[dashboard.overall];
  return (
    <div data-testid="pipeline-dashboard">
      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", padding: "0.7rem 0.9rem", borderRadius: 10, marginBottom: "0.9rem", border: `1px solid ${overall.color}`, background: `color-mix(in srgb, ${overall.color} 12%, transparent)` }}>
        <span aria-hidden style={{ width: 14, height: 14, borderRadius: "50%", background: overall.color, boxShadow: `0 0 10px 2px ${overall.color}` }} />
        <span data-testid="pipeline-overall" style={{ fontWeight: 700, fontSize: "1.05rem", color: "var(--wp-text, #e6e9ef)" }}>{CI_OVERALL[dashboard.overall]}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--wp-text-dim)" }}>{dashboard.summary.passed} passed &middot; {dashboard.summary.failed} failed &middot; {dashboard.summary.pending} running</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.75rem" }}>
        {dashboard.categories.filter((c) => c.status !== "absent" || c.key !== "other").map((c) => {
          const light = CI_LIGHT[c.status];
          const n = c.failed || c.pending || c.passed;
          return (
            <div key={c.key} data-testid={`pipeline-cat-${c.key}`} style={{ position: "relative", background: "var(--wp-surface-2, #171a21)", border: `1px solid ${c.status === "absent" ? "var(--wp-border, #2a2f3a)" : light.color}`, borderRadius: 12, padding: "0.85rem 0.9rem", opacity: c.status === "absent" ? 0.55 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span aria-hidden style={{ width: 11, height: 11, borderRadius: "50%", flexShrink: 0, background: light.color, boxShadow: c.status === "absent" ? "none" : `0 0 8px 1px ${light.color}` }} />
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--wp-text, #e6e9ef)" }}>{c.label}</span>
              </div>
              <div style={{ marginTop: "0.5rem", fontSize: "0.78rem", color: light.color, fontWeight: 600 }}>{light.label}</div>
              {n > 0 && c.status !== "absent" && (
                <div style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)", marginTop: "0.15rem" }}>{n} check{n === 1 ? "" : "s"}</div>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: "0.7rem 0 0", fontSize: "0.72rem", color: "var(--wp-text-dim)", lineHeight: 1.45 }}>
        Each light is a checkpoint in your delivery flow through build and deploy. Green means that class of check passed; the tools that ran it stay under the hood.
      </p>
    </div>
  );
}
