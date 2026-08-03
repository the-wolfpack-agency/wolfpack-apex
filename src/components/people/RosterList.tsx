"use client";

/**
 * The single list on /hr: everyone in the workspace, and whether they can sign in.
 *
 * It replaces the employees-only list, which showed `apex_employees` alone.
 * That list could not show the results of its own "Invite to Instinct" button:
 * you invited somebody, they got access, and they appeared nowhere. There was
 * also no way to take access away or give it back.
 *
 * One list rather than two. The previous double-list bug (a56b5950) came from
 * rendering the read-only list and the edit surface separately, so the row here
 * carries every action it supports:
 *
 *   Edit / Delete       the HR record. Present when the person has one.
 *   Revoke / Restore    the account. Present when the person has one AND the
 *                       viewer holds settings.manage_team.
 *
 * HR can see access but not change it, which is why the buttons are driven by
 * `can_manage_access` from the server rather than assumed. That flag only hides
 * controls; /api/people/roster/[id]/access enforces the capability itself.
 */

import { useCallback, useEffect, useState, FormEvent } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

export type AccessState = "active" | "revoked" | "invited" | "none";

export interface RosterEntry {
  key: string;
  name: string;
  email: string | null;
  role_title: string | null;
  department: string | null;
  employee_id: string | null;
  employee_status: string | null;
  member_id: string | null;
  account_role: string | null;
  invite_id: string | null;
  access: AccessState;
  last_login: string | null;
  m365_connected: boolean;
}

/** Wording aimed at the question being asked: can this person get in? */
const ACCESS_LABEL: Record<AccessState, string> = {
  active: "Has access",
  invited: "Invited",
  revoked: "Access removed",
  none: "No account",
};

const ACCESS_COLOR: Record<AccessState, string> = {
  active: "var(--wp-success)",
  invited: "var(--wp-gold)",
  revoked: "var(--wp-error)",
  none: "var(--wp-text-dim)",
};

/**
 * `refreshToken` changes when something elsewhere on the tab added an employee
 * or sent an invite. Both change the roster, and without this the person you
 * just added stays invisible until a reload, which is the complaint itself.
 */
export function RosterList({ refreshToken = 0 }: { refreshToken?: number } = {}) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [canManageAccess, setCanManageAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDept, setEditDept] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [accessMsg, setAccessMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const r = await fetchWithRefresh("/api/people/roster");
      if (r.ok) {
        const data = await r.json();
        setRoster(data.roster ?? []);
        setCanManageAccess(Boolean(data.can_manage_access));
      } else {
        /* An empty list here would read as "nobody works here", which is a
           worse lie than an error. Say the roster could not be loaded. */
        const data = await r.json().catch(() => ({}));
        setLoadError(data.error ?? "Could not load the roster.");
      }
    } catch {
      setLoadError("Could not load the roster.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  function startEdit(entry: RosterEntry) {
    setEditingId(entry.employee_id);
    setEditName(entry.name);
    setEditEmail(entry.email ?? "");
    setEditTitle(entry.role_title ?? "");
    setEditDept(entry.department ?? "");
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
        setTimeout(() => cancelEdit(), 400);
      } else {
        const data = await r.json().catch(() => ({}));
        setMsg(data.error ?? "Save failed");
      }
    } catch {
      setMsg("Save failed");
    }
    setSaving(false);
  }

  async function handleDelete(entry: RosterEntry) {
    if (!entry.employee_id) return;
    /* Naming the consequence, because deleting the HR record of somebody who
       still has an account does NOT remove their access. Those are separate
       registers and conflating them is how a leaver keeps working credentials. */
    const warning =
      entry.member_id && entry.access === "active"
        ? `Delete the employee record for ${entry.name}? They will keep their access to Instinct. Use Remove access for that.`
        : `Delete ${entry.name}?`;
    const ok = typeof window !== "undefined" ? window.confirm(warning) : false;
    if (!ok) return;
    try {
      const r = await fetchWithRefresh(`/api/people/employees/${entry.employee_id}`, {
        method: "DELETE",
      });
      if (r.ok) {
        if (editingId === entry.employee_id) cancelEdit();
        await load();
      }
    } catch {
      // silent: the row stays so it can be retried
    }
  }

  async function handleAccess(entry: RosterEntry, active: boolean) {
    if (!entry.member_id) return;
    if (!active) {
      const ok =
        typeof window !== "undefined"
          ? window.confirm(
              `Remove ${entry.name}'s access to Instinct? They will not be able to sign in. You can restore it later.`,
            )
          : false;
      if (!ok) return;
    }
    setBusyMemberId(entry.member_id);
    setAccessMsg("");
    try {
      const r = await fetchWithRefresh(`/api/people/roster/${entry.member_id}/access`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ active }),
      });
      if (r.ok) {
        await load();
      } else {
        const data = await r.json().catch(() => ({}));
        setAccessMsg(data.error ?? "Could not change access.");
      }
    } catch {
      setAccessMsg("Could not change access.");
    }
    setBusyMemberId(null);
  }

  return (
    <div style={{ marginTop: "1.5rem" }} data-testid="employee-editor">
      <h3 style={{ fontSize: "1rem", margin: "0 0 0.75rem", color: "var(--wp-gold)" }}>
        Team &amp; access
      </h3>

      {accessMsg && (
        <p data-testid="roster-access-error" style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}>
          {accessMsg}
        </p>
      )}

      {loading ? (
        <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>Loading…</p>
      ) : loadError ? (
        <p data-testid="roster-load-error" style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}>
          {loadError}
        </p>
      ) : roster.length === 0 ? (
        <p style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
          Nobody yet. Add an employee or invite a teammate.
        </p>
      ) : (
        <ul
          style={{ listStyle: "none", padding: 0, fontSize: "0.85rem" }}
          data-testid="employee-editor-list"
        >
          {roster.map((entry) => (
            <li
              key={entry.key}
              style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--wp-border)" }}
              data-testid={`roster-row-${entry.key}`}
            >
              {entry.employee_id && editingId === entry.employee_id ? (
                <form
                  onSubmit={(ev) => handleSave(ev, entry.employee_id as string)}
                  style={{ display: "grid", gap: "0.5rem" }}
                  data-testid={`employee-edit-form-${entry.employee_id}`}
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
                    <button type="submit" disabled={saving} style={btn("var(--wp-gold)")}>
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button type="button" onClick={cancelEdit} style={btn()}>
                      Cancel
                    </button>
                    {msg && (
                      <span
                        data-testid={`employee-edit-msg-${entry.employee_id}`}
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
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <strong>{entry.name}</strong>{" "}
                    <span
                      data-testid={`roster-access-${entry.key}`}
                      style={{ color: ACCESS_COLOR[entry.access], fontWeight: 600 }}
                    >
                      {ACCESS_LABEL[entry.access]}
                    </span>
                    <span style={{ color: "var(--wp-text-dim)" }}>
                      {entry.role_title && ` · ${entry.role_title}`}
                      {entry.department && ` (${entry.department})`}
                      {entry.email && ` · ${entry.email}`}
                      {entry.account_role && ` · ${entry.account_role}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    {entry.employee_id && (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(entry)}
                          aria-label={`Edit ${entry.name}`}
                          data-testid={`employee-edit-btn-${entry.employee_id}`}
                          style={btn()}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(entry)}
                          aria-label={`Delete ${entry.name}`}
                          data-testid={`employee-delete-btn-${entry.employee_id}`}
                          style={{ ...btn(), color: "var(--wp-error)" }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {canManageAccess && entry.member_id && entry.access === "active" && (
                      <button
                        type="button"
                        disabled={busyMemberId === entry.member_id}
                        onClick={() => handleAccess(entry, false)}
                        aria-label={`Remove access for ${entry.name}`}
                        data-testid={`access-revoke-btn-${entry.member_id}`}
                        style={{ ...btn(), color: "var(--wp-error)" }}
                      >
                        Remove access
                      </button>
                    )}
                    {canManageAccess && entry.member_id && entry.access === "revoked" && (
                      <button
                        type="button"
                        disabled={busyMemberId === entry.member_id}
                        onClick={() => handleAccess(entry, true)}
                        aria-label={`Restore access for ${entry.name}`}
                        data-testid={`access-restore-btn-${entry.member_id}`}
                        style={btn("var(--wp-gold)")}
                      >
                        Restore access
                      </button>
                    )}
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

export default RosterList;
