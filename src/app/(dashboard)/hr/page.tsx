"use client";

/**
 * HR — Alicia's workspace.
 *
 * Renamed from "People" → "HR" because direct labels read better next
 * to the rest of the sidebar (Clients, Reports, etc).
 *
 * Single page, modular sub-tabs:
 *   Overview / Employees / Benefits / Documents / Insights
 *
 * Role-gated to ceo/cto/hr in the sidebar layout. Every interaction
 * fires an analytics event so the brain learns Alicia's workflows.
 */

import { useEffect, useState } from "react";
import { OverviewTab } from "@/components/people/OverviewTab";
import { EmployeesTab } from "@/components/people/EmployeesTab";
import { RosterList } from "@/components/people/RosterList";
import { OnboardingTab } from "@/components/people/OnboardingTab";
import { BenefitsTab } from "@/components/people/BenefitsTab";
import { DocumentsTab } from "@/components/people/DocumentsTab";
import { InsightsTab } from "@/components/people/InsightsTab";

type Tab = "overview" | "employees" | "onboarding" | "benefits" | "documents" | "insights";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "employees", label: "Employees" },
  { id: "onboarding", label: "Onboarding" },
  { id: "benefits", label: "Benefits" },
  { id: "documents", label: "Documents" },
  { id: "insights", label: "Insights" },
];


export default function HrPage() {
  const [tab, setTab] = useState<Tab>("overview");
  /* Bumped when an employee is added or an invite sent, so the roster refetches. */
  const [rosterVersion, setRosterVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("hr_tab") as Tab | null;
    if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("hr_tab", tab);
  }, [tab]);

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>HR</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          Onboarding, benefits, employee data, documents, and the insights the brain finds across them.
        </p>
      </div>

      <div role="tablist" style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--wp-border)", marginBottom: "1.5rem", flexWrap: "wrap" }}>
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
      {/* EmployeesTab renders the count header + Invite / Add-employee
          controls; RosterList renders the single canonical list. It shows
          everyone in the workspace, not only the employee records somebody
          typed in, so an invited teammate is now visible and their access can
          be removed and restored. Still exactly one list: the double-list bug
          (a56b5950) was EmployeesTab ALSO rendering one. */}
      {tab === "employees" && (
        <>
          <EmployeesTab onChanged={() => setRosterVersion((v) => v + 1)} />
          <RosterList refreshToken={rosterVersion} />
        </>
      )}
      {tab === "onboarding" && <OnboardingTab />}
      {tab === "benefits" && <BenefitsTab />}
      {tab === "documents" && <DocumentsTab />}
      {tab === "insights" && <InsightsTab />}
    </div>
  );
}
