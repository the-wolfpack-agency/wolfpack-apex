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

import { useEffect, useState, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import { OverviewTab } from "@/components/people/OverviewTab";
import { EmployeesTab } from "@/components/people/EmployeesTab";
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

interface Employee {
  id: string;
  full_name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  status: string;
}

/**
 * EmployeeEditor — companion panel to EmployeesTab that adds edit+delete.
 *
 * Kept inline here (not in components/people) because this page owns the
 * employee edit/delete UI per the 2026-04-23 task split. The read/create
 * path is still handled by <EmployeesTab />; this panel just drives the
 * PUT / DELETE /api/people/employees/[id] surface that shipped today.
 *
 * All fetches go through fetchWithRefresh — raw fetch from a client
 * component is the April 16 blank-dashboard bug pattern.
 */
function EmployeeEditor() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDept, setEditDept] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    setLoading(true);
    try {
      const r = await fetchWithRefresh("/api/people/employees");
      if (r.ok) {
        const data = await r.json();
        setEmployees(data.employees ?? []);
      }
    } catch {
      // network hiccup — leave list empty
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(emp: Employee) {
    setEditingId(emp.id);
    setEditName(emp.full_name);
    setEditEmail(emp.email ?? "");
    setEditTitle(emp.role_title ?? "");
    setEditDept(emp.department ?? "");
    setMsg("");
  }

  function cancelEdit() {
    setEditingId(null);
    setMsg("");
  }

  async function handleSave(e: FormEvent, id: string) {
    e.preventDefault();
    if (!editName.trim()) {
      setMsg("Full name is required");
      return;
    }
    setSaving(true);
    setMsg("");
    try {
      const r = await fetchWithRefresh(`/api/people/employees/${id}`, {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({
          full_name: editName,
          email: editEmail || null,
          role_title: editTitle || null,
          department: editDept || null,
        }),
      });
      if (r.ok) {
        setMsg("Saved");
        await load();
        setTimeout(() => {
          cancelEdit();
        }, 400);
      } else {
        const data = await r.json().catch(() => ({}));
        setMsg(data.error ?? "Save failed");
      }
    } catch {
      setMsg("Save failed");
    }
    setSaving(false);
  }

  async function handleDelete(emp: Employee) {
    const ok =
      typeof window !== "undefined"
        ? window.confirm(`Delete ${emp.full_name}?`)
        : false;
    if (!ok) return;
    try {
      const r = await fetchWithRefresh(`/api/people/employees/${emp.id}`, {
        method: "DELETE",
      });
      if (r.ok) {
        setEmployees((prev) => prev.filter((e) => e.id !== emp.id));
        if (editingId === emp.id) cancelEdit();
      }
    } catch {
      // silent — the row stays for retry
    }
  }

  return (
    <div style={{ marginTop: "1.5rem" }} data-testid="employee-editor">
      <h3 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "var(--wp-gold)" }}>
        Edit / Delete
      </h3>
      {loading ? (
        <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>Loading…</p>
      ) : employees.length === 0 ? (
        <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
          No employees to edit.
        </p>
      ) : (
        <ul
          style={{ listStyle: "none", padding: 0, fontSize: "0.85rem" }}
          data-testid="employee-editor-list"
        >
          {employees.map((e) => (
            <li
              key={e.id}
              style={{
                padding: "0.6rem 0",
                borderBottom: "1px solid var(--wp-border)",
              }}
              data-testid={`employee-editor-row-${e.id}`}
            >
              {editingId === e.id ? (
                <form
                  onSubmit={(ev) => handleSave(ev, e.id)}
                  style={{ display: "grid", gap: "0.5rem" }}
                  data-testid={`employee-edit-form-${e.id}`}
                >
                  <input
                    value={editName}
                    onChange={(ev) => setEditName(ev.target.value)}
                    placeholder="Full name"
                    aria-label="Edit full name"
                    required
                    style={inputStyle}
                  />
                  <input
                    value={editEmail}
                    onChange={(ev) => setEditEmail(ev.target.value)}
                    placeholder="Email"
                    aria-label="Edit email"
                    type="email"
                    style={inputStyle}
                  />
                  <input
                    value={editTitle}
                    onChange={(ev) => setEditTitle(ev.target.value)}
                    placeholder="Role title"
                    aria-label="Edit title"
                    style={inputStyle}
                  />
                  <input
                    value={editDept}
                    onChange={(ev) => setEditDept(ev.target.value)}
                    placeholder="Department"
                    aria-label="Edit department"
                    style={inputStyle}
                  />
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button
                      type="submit"
                      disabled={saving}
                      style={btn("var(--wp-gold)")}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button type="button" onClick={cancelEdit} style={btn()}>
                      Cancel
                    </button>
                    {msg && (
                      <span
                        data-testid={`employee-edit-msg-${e.id}`}
                        style={{
                          color: msg === "Saved" ? "var(--wp-success)" : "var(--wp-error)",
                          fontSize: "0.8rem",
                        }}
                      >
                        {msg}
                      </span>
                    )}
                  </div>
                </form>
              ) : (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <div>
                    <strong>{e.full_name}</strong>{" "}
                    <span style={{ color: "var(--wp-text-dim)" }}>
                      {e.role_title && `— ${e.role_title}`}{" "}
                      {e.department && `(${e.department})`}{" "}
                      {e.email && `· ${e.email}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    <button
                      type="button"
                      onClick={() => startEdit(e)}
                      aria-label={`Edit ${e.full_name}`}
                      data-testid={`employee-edit-btn-${e.id}`}
                      style={btn()}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(e)}
                      aria-label={`Delete ${e.full_name}`}
                      data-testid={`employee-delete-btn-${e.id}`}
                      style={{ ...btn(), color: "var(--wp-error)" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.8rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "5px",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
};
function btn(bg = "var(--wp-card)"): React.CSSProperties {
  return {
    padding: "0.4rem 0.75rem",
    background: bg,
    color: bg === "var(--wp-card)" ? "var(--wp-text)" : "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "5px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.8rem",
  };
}

export default function HrPage() {
  const [tab, setTab] = useState<Tab>("overview");

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
          controls; EmployeeEditor renders the single canonical employee
          list with inline edit/delete. The earlier double-list bug
          (a56b5950) was EmployeesTab ALSO rendering a read-only list -
          that list has been removed there, so there is exactly one list
          and the edit/delete CRUD surface is reachable again. */}
      {tab === "employees" && (
        <>
          <EmployeesTab />
          <EmployeeEditor />
        </>
      )}
      {tab === "onboarding" && <OnboardingTab />}
      {tab === "benefits" && <BenefitsTab />}
      {tab === "documents" && <DocumentsTab />}
      {tab === "insights" && <InsightsTab />}
    </div>
  );
}
