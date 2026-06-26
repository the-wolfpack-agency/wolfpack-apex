"use client";

/**
 * /admin/agents: onboard and manage agent principals (OGIAM, agents as
 * first-class users).
 *
 * Agent principals are AI actors that the system treats like teammates: each
 * has an identity, a role, an owner, and a lifecycle (invited, active, paused,
 * revoked). Every action an agent takes is gated by OGIAM, so this roster is
 * the directory of WHO can act; the OGIAM decision explorer is the record of
 * WHAT they did. Onboarding mints a one-time secret, the agent's joining
 * credential, shown exactly once.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). The route is capability-gated on the API side.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

type AgentState = "invited" | "active" | "paused" | "revoked";

interface AgentRecord {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  ownerUserId: string | null;
  state: AgentState;
  identityProvider: string;
  externalSubject: string | null;
  scanStatus: "pending" | "complete";
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface AgentsResponse {
  agents: AgentRecord[];
}

interface OnboardResponse {
  agent: AgentRecord;
  onboarding_secret: string;
}

/* The role options offered when onboarding an agent. Mirrors the human
   TeamRole set so an agent slots into the same role model teammates use, plus
   designer for design-surface principals. Plain strings, not the strict
   TeamRole type: the API validates server-side and this list is the form's
   source of truth for the select. */
const ROLE_OPTIONS = [
  "ceo",
  "cto",
  "evp",
  "vp",
  "cco",
  "dev",
  "sales",
  "ops",
  "hr",
  "designer",
] as const;

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* State-chip colors. Invited grey (pending join), active green, paused amber,
   revoked red. Tuned to read on the dark surface, falling back when the
   var(--wp-*) token is absent. */
function stateColor(state: AgentState): { fg: string; bg: string } {
  switch (state) {
    case "active":
      return { fg: "var(--wp-success, #22c55e)", bg: "rgba(34,197,94,0.12)" };
    case "paused":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    case "revoked":
      return { fg: "var(--wp-error, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.12)" };
  }
}

function StateChip({ state, id }: { state: AgentState; id?: string }) {
  const c = stateColor(state);
  return (
    <span
      data-testid={id ? `agent-state-chip-${id}` : undefined}
      style={{
        padding: "0.1rem 0.55rem",
        borderRadius: "10px",
        fontSize: "0.7rem",
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.fg}`,
        textTransform: "capitalize",
        fontWeight: 600,
      }}
    >
      {state}
    </span>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Onboard form state.
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(ROLE_OPTIONS[5]); // dev by default
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /* The one-time secret returned by a successful onboard. Held in state so the
     secret panel renders; cleared when the operator dismisses it. Never
     refetched, the API never returns it again. */
  const [secret, setSecret] = useState<{ agent: AgentRecord; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/agents");
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to manage agent principals.");
        } else {
          setError(`Could not load agents (HTTP ${res.status}).`);
        }
        setAgents([]);
        return;
      }
      const body = (await res.json()) as AgentsResponse;
      setAgents(body.agents ?? []);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onboard(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("Give the agent a name.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/agents", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: trimmed,
          role,
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });
      if (res.status === 409) {
        setFormError("That name is already taken. Pick another.");
        return;
      }
      if (res.status === 400) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setFormError(b.error ? `Invalid: ${b.error}` : "Invalid agent details.");
        return;
      }
      if (!res.ok) {
        setFormError(`Could not onboard agent (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as OnboardResponse;
      setSecret({ agent: body.agent, value: body.onboarding_secret });
      setCopied(false);
      // Reset the form for the next onboard and refresh the roster.
      setName("");
      setDescription("");
      await load();
    } catch (e) {
      setFormError((e as Error).message || "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard?.writeText(secret.value);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (no permission / insecure context). The
      // secret is shown in full so the operator can copy it manually; just
      // signal that the one-click copy did not take.
      setCopied(false);
    }
  }

  return (
    <div
      data-testid="admin-agents-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "920px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          Agents
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Link
            href="/admin/agents/approvals"
            data-testid="agents-approvals-link"
            title="Writes an agent has proposed, awaiting your approval before they run."
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-gold, #f1c233)",
              border: "1px solid var(--wp-gold, #f1c233)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            Write approvals
          </Link>
          <Link
            href="/admin/platform-scans"
            data-testid="agents-platform-scans-link"
            title="Bugs and use-case gaps an agent found by scanning a target platform's journeys."
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-gold, #f1c233)",
              border: "1px solid var(--wp-gold, #f1c233)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            Platform scans
          </Link>
          <Link
            href="/admin/connectors"
            data-testid="agents-connectors-link"
            title="Client platforms an agent is connected to with a saved login, ready for an authenticated scan."
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-gold, #f1c233)",
              border: "1px solid var(--wp-gold, #f1c233)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            Connections
          </Link>
          <Link
            href="/admin/agents/memory"
            data-testid="agents-memory-link"
            title="What the agents have learned: the shared procedures one agent records and another inherits."
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-gold, #f1c233)",
              border: "1px solid var(--wp-gold, #f1c233)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              textDecoration: "none",
            }}
          >
            Shared memory
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text-dim, #aaa)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "6px",
              padding: "0.4rem 0.9rem",
              fontSize: "0.85rem",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1.5rem 0", fontSize: "0.9rem" }}>
        These are AI principals, governed by OGIAM and onboarded like teammates.
        Each carries a role, an owner, and a lifecycle; every action it takes is
        gated and recorded in the AI Gateway decision log.
      </p>

      {/* One-time secret panel. Renders prominently after a successful onboard
          and is the only place the credential is ever shown. */}
      {secret && (
        <div
          data-testid="agent-onboarding-secret"
          style={{
            padding: "1rem 1.1rem",
            marginBottom: "1.5rem",
            background: "rgba(34,197,94,0.06)",
            border: "1px solid var(--wp-success, #22c55e)",
            borderRadius: "8px",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--wp-success, #22c55e)", fontSize: "0.95rem" }}>
            {secret.agent.name} onboarded
          </div>
          <div
            data-testid="agent-onboarding-secret-warning"
            style={{
              marginTop: "0.4rem",
              fontSize: "0.82rem",
              color: "var(--wp-text-dim, #aaa)",
            }}
          >
            Shown once. Copy it now; it is the agent&apos;s onboarding credential
            and is never shown again.
          </div>
          <div
            style={{
              marginTop: "0.7rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <code
              data-testid="agent-onboarding-secret-value"
              style={{
                flex: "1 1 320px",
                padding: "0.55rem 0.7rem",
                background: "var(--wp-dark-surface2, #1a1a1a)",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: "6px",
                fontFamily: "var(--wp-mono, monospace)",
                fontSize: "0.82rem",
                color: "var(--wp-text, #eee)",
                wordBreak: "break-all",
              }}
            >
              {secret.value}
            </code>
            <button
              type="button"
              data-testid="agent-onboarding-secret-copy"
              onClick={() => void copySecret()}
              style={{
                padding: "0.5rem 0.9rem",
                borderRadius: "6px",
                fontSize: "0.8rem",
                fontWeight: 600,
                background: "var(--wp-gold, #f1c233)",
                color: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-gold, #f1c233)",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              data-testid="agent-onboarding-secret-dismiss"
              onClick={() => setSecret(null)}
              style={{
                padding: "0.5rem 0.9rem",
                borderRadius: "6px",
                fontSize: "0.8rem",
                background: "transparent",
                color: "var(--wp-text-dim, #aaa)",
                border: "1px solid var(--wp-dark-border, #333)",
                cursor: "pointer",
              }}
            >
              I saved it
            </button>
          </div>
        </div>
      )}

      {/* Onboard form. */}
      <form
        data-testid="agent-onboard-form"
        onSubmit={(e) => void onboard(e)}
        style={{
          padding: "1.1rem 1.2rem",
          marginBottom: "1.75rem",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
          borderRadius: "8px",
        }}
      >
        <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.9rem", color: "var(--wp-text, #eee)" }}>
          Onboard an agent
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <label style={{ flex: "2 1 220px", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>Name</span>
            <input
              type="text"
              data-testid="agent-onboard-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research Scout"
              maxLength={120}
              style={{
                padding: "0.5rem 0.7rem",
                fontSize: "0.9rem",
                background: "var(--wp-dark-surface2, #1a1a1a)",
                color: "var(--wp-text, #eee)",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: "6px",
              }}
            />
          </label>
          <label style={{ flex: "1 1 140px", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>Role</span>
            <select
              data-testid="agent-onboard-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{
                padding: "0.5rem 0.7rem",
                fontSize: "0.9rem",
                background: "var(--wp-dark-surface2, #1a1a1a)",
                color: "var(--wp-text, #eee)",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: "6px",
                textTransform: "uppercase",
              }}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginBottom: "0.75rem" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>
            Description (optional)
          </span>
          <textarea
            data-testid="agent-onboard-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this agent for? Helps the team understand its remit."
            rows={2}
            maxLength={500}
            style={{
              padding: "0.5rem 0.7rem",
              fontSize: "0.88rem",
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text, #eee)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "6px",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        </label>
        {formError && (
          <div
            data-testid="agent-onboard-error"
            style={{
              marginBottom: "0.75rem",
              padding: "0.5rem 0.7rem",
              background: "rgba(239,68,68,0.08)",
              color: "var(--wp-error, #ef4444)",
              border: "1px solid var(--wp-error, #ef4444)",
              borderRadius: "6px",
              fontSize: "0.82rem",
            }}
          >
            {formError}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            data-testid="agent-onboard-submit"
            disabled={submitting}
            style={{
              padding: "0.5rem 1.1rem",
              borderRadius: "6px",
              fontSize: "0.88rem",
              fontWeight: 600,
              background: "var(--wp-gold, #f1c233)",
              color: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-gold, #f1c233)",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Onboarding..." : "Onboard agent"}
          </button>
        </div>
      </form>

      {error && (
        <div
          data-testid="agents-error"
          style={{
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {!error && !loading && agents.length === 0 && (
        <div
          data-testid="agents-empty"
          style={{
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          No agent principals yet. Onboard one above to give an AI actor a
          governed identity.
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="agents-roster">
        {agents.map((a) => (
          <li
            key={a.id}
            data-testid={`agent-row-${a.id}`}
            style={{
              marginBottom: "0.5rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "8px",
            }}
          >
            <Link
              href={`/admin/agents/${a.id}`}
              style={{
                display: "block",
                padding: "1rem 1.1rem",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <div style={{ fontSize: "0.95rem", color: "var(--wp-text, #eee)" }}>
                  <strong>{a.name}</strong>
                  <span
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.78rem",
                      color: "var(--wp-text-dim, #aaa)",
                      textTransform: "uppercase",
                    }}
                  >
                    {a.role}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <StateChip state={a.state} id={a.id} />
                  <span
                    title={a.createdAt}
                    style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    {relativeTime(a.createdAt)}
                  </span>
                </div>
              </div>
              <div
                style={{
                  marginTop: "0.4rem",
                  fontSize: "0.78rem",
                  color: "var(--wp-text-muted, #6b7280)",
                }}
              >
                owner: {a.ownerUserId ?? "unassigned"}
                {a.description ? ` · ${a.description}` : ""}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
