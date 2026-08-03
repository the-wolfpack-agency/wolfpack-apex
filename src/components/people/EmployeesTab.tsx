"use client";

import { fetchWithRefresh } from "@/lib/client-auth";

import { useState } from "react";
import { jsonHeaders } from "./auth";
import InviteMemberDialog from "@/components/team/InviteMemberDialog";

/**
 * The Add / Invite controls for the Employees tab.
 *
 * It deliberately holds no list. RosterList below it owns that, because the
 * roster is everyone in the workspace and this component only knew about
 * `apex_employees`. A header reading "Employees (2)" above a list of five
 * people is the same wrong count the page was rebuilt to stop reporting.
 *
 * `onChanged` tells the page something was added so the roster refetches;
 * without it a newly added employee would not appear until a reload.
 */
export function EmployeesTab({ onChanged }: { onChanged?: () => void } = {}) {
  const [showForm, setShowForm] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [dept, setDept] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await fetchWithRefresh("/api/people/employees", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ full_name: name, email, role_title: title, department: dept }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "create failed");
      return;
    }
    setShowForm(false);
    setName("");
    setEmail("");
    setTitle("");
    setDept("");
    onChanged?.();
  }

  return (
    <div data-tab="employees">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem", gap: "0.5rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>Employees</h3>
        {!showForm && (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => setShowInviteDialog(true)}
              data-testid="open-invite-dialog"
              style={btn()}
              title="Invite a teammate to log into Instinct"
            >
              + Invite to Instinct
            </button>
            <button onClick={() => setShowForm(true)} style={btn("var(--wp-gold)")}>
              + Add employee
            </button>
          </div>
        )}
      </div>

      <InviteMemberDialog
        open={showInviteDialog}
        onClose={() => {
          setShowInviteDialog(false);
          /* An invite creates a pending row, so the roster changes even though
             nothing was added here. Without this the teammate you just invited
             stays invisible until a reload, which is the whole complaint. */
          onChanged?.();
        }}
      />

      {showForm && (
        <form
          onSubmit={create}
          style={{ display: "grid", gap: "0.75rem", padding: "1rem", background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "8px", marginBottom: "1rem" }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required style={inputStyle} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" type="email" style={inputStyle} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Role title" style={inputStyle} />
          <input value={dept} onChange={(e) => setDept(e.target.value)} placeholder="Department" style={inputStyle} />
          {error && <div style={{ color: "#c44", fontSize: "0.85rem" }}>{error}</div>}
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setShowForm(false)} style={btn()}>
              Cancel
            </button>
            <button type="submit" style={btn("var(--wp-gold)")}>
              Add employee
            </button>
          </div>
        </form>
      )}

      {/* The employee list itself is rendered by <EmployeeEditor /> (which
          adds inline edit/delete) immediately below this header on the
          /hr employees tab. This component intentionally no longer renders
          its own read-only list - that duplication was the double-list bug
          fixed in a56b5950. We keep the count header + Invite / Add
          controls here so the page has a single source of truth for the
          list while the edit/delete CRUD surface stays reachable. */}
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
    padding: "0.5rem 1rem",
    background: bg,
    color: bg === "var(--wp-card)" ? "var(--wp-text)" : "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "5px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.85rem",
  };
}
