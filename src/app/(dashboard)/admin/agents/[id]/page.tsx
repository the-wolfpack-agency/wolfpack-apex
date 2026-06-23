"use client";

/**
 * /admin/agents/[id]: profile + lifecycle controls for one agent principal.
 *
 * Shows the agent's identity (id, identity provider, external subject), role,
 * owner, current state, scan status, and the relative timeline (created,
 * activated, last seen). Lifecycle buttons pause, resume, or revoke the agent
 * via PATCH; revoke is irreversible and gated behind an inline confirm. A link
 * to the OGIAM decision explorer is the bridge from WHO (this profile) to WHAT
 * (the gated actions this agent has taken).
 *
 * Auth: every fetch goes through fetchWithRefresh.
 */

import { useCallback, useEffect, useState, use } from "react";
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

interface AgentResponse {
  agent: AgentRecord;
}

type LifecycleAction = "pause" | "resume" | "revoke";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
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

function Field({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {label}
      </span>
      <span
        data-testid={testid}
        style={{ fontSize: "0.9rem", color: "var(--wp-text, #eee)", wordBreak: "break-word" }}
      >
        {value}
      </span>
    </div>
  );
}

export default function AgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Set when revoke is armed: revoke is irreversible, so the first click arms
     an inline confirm and the second click performs the PATCH. */
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        setAgent(null);
        return;
      }
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to view this agent.");
        } else {
          setError(`Could not load agent (HTTP ${res.status}).`);
        }
        setAgent(null);
        return;
      }
      const body = (await res.json()) as AgentResponse;
      setAgent(body.agent ?? null);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(action: LifecycleAction) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error || `Could not ${action} agent (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as AgentResponse;
      setAgent(body.agent ?? null);
      setConfirmingRevoke(false);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  const wrap = {
    padding: "2rem 1.5rem",
    maxWidth: "760px",
    margin: "0 auto",
    color: "var(--wp-text, #eee)",
  } as const;

  const backLink = (
    <Link
      href="/admin/agents"
      data-testid="agent-back-link"
      style={{ fontSize: "0.82rem", color: "var(--wp-text-dim, #aaa)", textDecoration: "none" }}
    >
      &larr; All agents
    </Link>
  );

  if (loading) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div data-testid="agent-loading" style={{ marginTop: "1.5rem", color: "var(--wp-text-dim, #aaa)" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div
          data-testid="agent-not-found"
          style={{
            marginTop: "1.5rem",
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          No agent with id <code>{id}</code> was found. It may have been removed,
          or the id is wrong.
        </div>
      </div>
    );
  }

  if (error && !agent) {
    return (
      <div data-testid="admin-agent-page" style={wrap}>
        {backLink}
        <div
          data-testid="agent-error"
          style={{
            marginTop: "1.5rem",
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!agent) return <div data-testid="admin-agent-page" style={wrap}>{backLink}</div>;

  const c = stateColor(agent.state);
  const isRevoked = agent.state === "revoked";

  return (
    <div data-testid="admin-agent-page" style={wrap}>
      {backLink}

      <div
        style={{
          marginTop: "1rem",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h1 data-testid="agent-name" style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          {agent.name}
        </h1>
        <span
          data-testid="agent-state-chip"
          style={{
            padding: "0.15rem 0.6rem",
            borderRadius: "10px",
            fontSize: "0.75rem",
            background: c.bg,
            color: c.fg,
            border: `1px solid ${c.fg}`,
            textTransform: "capitalize",
            fontWeight: 600,
          }}
        >
          {agent.state}
        </span>
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0.4rem 0 1.5rem 0", fontSize: "0.9rem" }}>
        An AI principal governed by OGIAM. Role <strong style={{ color: "var(--wp-text, #eee)", textTransform: "uppercase" }}>{agent.role}</strong>.
      </p>

      {error && (
        <div
          data-testid="agent-action-error"
          style={{
            padding: "0.6rem 0.9rem",
            marginBottom: "1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
            fontSize: "0.82rem",
          }}
        >
          {error}
        </div>
      )}

      {agent.description && (
        <div
          data-testid="agent-description"
          style={{
            padding: "0.9rem 1rem",
            marginBottom: "1.25rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px solid var(--wp-dark-border, #333)",
            borderRadius: "8px",
            fontSize: "0.9rem",
            lineHeight: 1.5,
            color: "var(--wp-text, #eee)",
          }}
        >
          {agent.description}
        </div>
      )}

      <div
        data-testid="agent-identity"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          padding: "1.1rem 1.2rem",
          marginBottom: "1.25rem",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
          borderRadius: "8px",
        }}
      >
        <Field label="Agent id" value={agent.id} testid="agent-id" />
        <Field label="Identity provider" value={agent.identityProvider} testid="agent-identity-provider" />
        <Field
          label="External subject"
          value={agent.externalSubject ?? "not linked"}
          testid="agent-external-subject"
        />
        <Field label="Role" value={agent.role.toUpperCase()} testid="agent-role" />
        <Field label="Owner" value={agent.ownerUserId ?? "unassigned"} testid="agent-owner" />
        <Field
          label="Scan status"
          value={agent.scanStatus === "complete" ? "Complete" : "Pending"}
          testid="agent-scan-status"
        />
        <Field label="Created" value={relativeTime(agent.createdAt)} testid="agent-created" />
        <Field label="Activated" value={relativeTime(agent.activatedAt)} testid="agent-activated" />
        <Field label="Last seen" value={relativeTime(agent.lastSeenAt)} testid="agent-last-seen" />
      </div>

      {/* Lifecycle controls. Pause/resume are reversible; revoke is not, so it
          arms an inline confirm before the destructive PATCH. */}
      <div
        data-testid="agent-lifecycle"
        style={{
          display: "flex",
          gap: "0.6rem",
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        {agent.state === "active" && (
          <button
            type="button"
            data-testid="agent-pause"
            onClick={() => void runAction("pause")}
            disabled={busy}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-gold, #f1c233)",
              border: "1px solid var(--wp-gold, #f1c233)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "..." : "Pause"}
          </button>
        )}
        {(agent.state === "paused" || agent.state === "invited") && (
          <button
            type="button"
            data-testid="agent-resume"
            onClick={() => void runAction("resume")}
            disabled={busy}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-success, #22c55e)",
              border: "1px solid var(--wp-success, #22c55e)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "..." : "Resume"}
          </button>
        )}
        {!isRevoked && !confirmingRevoke && (
          <button
            type="button"
            data-testid="agent-revoke"
            onClick={() => setConfirmingRevoke(true)}
            disabled={busy}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "transparent",
              color: "var(--wp-error, #ef4444)",
              border: "1px solid var(--wp-error, #ef4444)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Revoke
          </button>
        )}
        {!isRevoked && confirmingRevoke && (
          <div
            data-testid="agent-revoke-confirm"
            style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <span style={{ fontSize: "0.82rem", color: "var(--wp-error, #ef4444)" }}>
              Revoke permanently? The agent loses its identity and cannot act again.
            </span>
            <button
              type="button"
              data-testid="agent-revoke-confirm-yes"
              onClick={() => void runAction("revoke")}
              disabled={busy}
              style={{
                padding: "0.45rem 0.9rem",
                borderRadius: "6px",
                fontSize: "0.82rem",
                fontWeight: 600,
                background: "var(--wp-error, #ef4444)",
                color: "#fff",
                border: "1px solid var(--wp-error, #ef4444)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Revoking..." : "Yes, revoke"}
            </button>
            <button
              type="button"
              data-testid="agent-revoke-confirm-cancel"
              onClick={() => setConfirmingRevoke(false)}
              disabled={busy}
              style={{
                padding: "0.45rem 0.9rem",
                borderRadius: "6px",
                fontSize: "0.82rem",
                background: "transparent",
                color: "var(--wp-text-dim, #aaa)",
                border: "1px solid var(--wp-dark-border, #333)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {isRevoked && (
          <span
            data-testid="agent-revoked-note"
            style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #6b7280)" }}
          >
            Revoked {relativeTime(agent.revokedAt)}. This agent can no longer act.
          </span>
        )}
      </div>

      {/* Bridge to the agent's governed activity. The OGIAM explorer is where
          this agent's gated actions show up once it acts. */}
      <Link
        href="/admin/ogiam"
        data-testid="agent-ogiam-link"
        style={{
          display: "inline-block",
          padding: "0.6rem 1rem",
          borderRadius: "6px",
          fontSize: "0.85rem",
          fontWeight: 600,
          background: "var(--wp-dark-surface, #1f1f22)",
          color: "var(--wp-gold, #f1c233)",
          border: "1px solid var(--wp-dark-border, #333)",
          textDecoration: "none",
        }}
      >
        View this agent&apos;s gated actions &rarr;
      </Link>
    </div>
  );
}
