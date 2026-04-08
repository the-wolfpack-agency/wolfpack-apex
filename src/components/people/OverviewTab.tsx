"use client";

import { useEffect, useState } from "react";
import { authHeaders } from "./auth";

export function OverviewTab() {
  const [employeeCount, setEmployeeCount] = useState<number | null>(null);
  const [docCount, setDocCount] = useState<number | null>(null);
  const [insightCount, setInsightCount] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/people/employees", { headers: authHeaders() }).then((r) => r.json()).then((d) => setEmployeeCount(d.employees?.length ?? 0)).catch(() => setEmployeeCount(0)),
      fetch("/api/people/benefits", { headers: authHeaders() }).then((r) => r.json()).then((d) => setDocCount(d.documents?.length ?? 0)).catch(() => setDocCount(0)),
      fetch("/api/people/insights", { headers: authHeaders() }).then((r) => r.json()).then((d) => setInsightCount(d.insights?.length ?? 0)).catch(() => setInsightCount(0)),
    ]);
  }, []);

  return (
    <div data-tab="overview">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
        <Card label="Employees" value={employeeCount} />
        <Card label="Benefits documents" value={docCount} />
        <Card label="Open insights" value={insightCount} />
      </div>
      <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem", marginTop: "1.5rem" }}>
        Use the tabs above to add employees, upload renewal PDFs, and review insights the brain has surfaced.
      </p>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{ padding: "1.25rem", background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "8px" }}>
      <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--wp-text-dim)", marginBottom: "0.4rem" }}>
        {label}
      </div>
      <div style={{ fontSize: "2rem", fontWeight: 700 }}>{value ?? "—"}</div>
    </div>
  );
}
