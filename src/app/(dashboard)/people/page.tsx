"use client";

/**
 * People — Alicia's HR workspace.
 *
 * Single page, modular sub-tabs (Overview, Employees, Benefits, Insights).
 * Role-gated to ceo/cto/hr in the sidebar layout. Every interaction
 * fires an analytics event so the brain learns Alicia's workflows.
 */

import { useEffect, useState } from "react";
import { OverviewTab } from "@/components/people/OverviewTab";
import { EmployeesTab } from "@/components/people/EmployeesTab";
import { BenefitsTab } from "@/components/people/BenefitsTab";
import { InsightsTab } from "@/components/people/InsightsTab";

type Tab = "overview" | "employees" | "benefits" | "insights";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "employees", label: "Employees" },
  { id: "benefits", label: "Benefits" },
  { id: "insights", label: "Insights" },
];

export default function PeoplePage() {
  const [tab, setTab] = useState<Tab>("overview");

  // Persist last tab so Alicia returns to where she left off
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("people_tab") as Tab | null;
    if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("people_tab", tab);
  }, [tab]);

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>People</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          Onboarding, benefits, employee data, and the insights the brain finds across them.
        </p>
      </div>

      <div role="tablist" style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--wp-border)", marginBottom: "1.5rem" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "0.6rem 1rem",
              background: "transparent",
              color: tab === t.id ? "var(--wp-gold)" : "var(--wp-text-dim)",
              border: "none",
              borderBottom: tab === t.id ? "2px solid var(--wp-gold)" : "2px solid transparent",
              fontWeight: tab === t.id ? 600 : 500,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "employees" && <EmployeesTab />}
      {tab === "benefits" && <BenefitsTab />}
      {tab === "insights" && <InsightsTab />}
    </div>
  );
}
