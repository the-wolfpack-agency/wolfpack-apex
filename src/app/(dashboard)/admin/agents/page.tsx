"use client";

/**
 * /admin/agents: the AGENT FLEET command center. Onboard and manage agent
 * principals (OGIAM, agents as first-class users).
 *
 * Agent principals are AI actors that the system treats like teammates: each
 * has an identity, a role, an owner, and a lifecycle (invited, active, paused,
 * revoked). Every action an agent takes is gated by OGIAM, so this roster is
 * the directory of WHO can act; the OGIAM decision explorer is the record of
 * WHAT they did. Onboarding mints a one-time secret, the agent's joining
 * credential, shown exactly once.
 *
 * Presentation: the dark-glass console kit (GlassPanel / MetricTile /
 * StatusPill / Sparkline / SectionHeader / ConsoleGrid). The data + every
 * control is unchanged from the prior roster page; only the surface is the new
 * command-center language so an operator reads fleet status + results at a
 * glance and drills into a single agent from a card.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). Unauthenticated visitors are redirected to /login, never
 * shown a blank surface. The route is capability-gated on the API side.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctUser,
} from "@/lib/client-auth";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  Sparkline,
  SectionHeader,
  ConsoleGrid,
  colorForStatus,
} from "@/components/console";

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
  /* The connector names BOUND to this agent: the systems it operates, which
     make it (for example) a Salesforce or Jira agent. The roster GET returns
     this so each card can show the agent's services at a glance. Optional so an
     older payload without it degrades to the "no service" hint, not a crash. */
  connections?: string[];
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

/* The header nav links, kept identical (href + testid + title) so the existing
   approvals / platform-scans / connectors / memory navigation is preserved
   verbatim; only the chrome is the console-kit treatment. */
const NAV_LINKS = [
  {
    href: "/admin/agents/approvals",
    testId: "agents-approvals-link",
    label: "Write approvals",
    title:
      "Writes an agent has proposed, awaiting your approval before they run.",
  },
  {
    href: "/admin/platform-scans",
    testId: "agents-platform-scans-link",
    label: "Platform scans",
    title:
      "Bugs and use-case gaps an agent found by scanning a target platform's journeys.",
  },
  {
    href: "/admin/connectors",
    testId: "agents-connectors-link",
    label: "Connections",
    title:
      "Client platforms an agent is connected to with a saved login, ready for an authenticated scan.",
  },
  {
    href: "/admin/agents/memory",
    testId: "agents-memory-link",
    label: "Shared memory",
    title:
      "What the agents have learned: the shared procedures one agent records and another inherits.",
  },
] as const;

/* Map an agent lifecycle state to the status word the console severity
   vocabulary already understands, so a fleet pill reads the same here as on
   every other admin console surface. "invited" has no word in the vocabulary,
   so it deliberately resolves to the neutral tone. */
function statusForState(state: AgentState): string {
  switch (state) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "revoked":
      return "failed";
    default:
      return "invited";
  }
}

const linkButtonStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface2, #1a1a1a)",
  color: "var(--wp-gold, #f1c233)",
  border: "1px solid var(--wp-gold, #f1c233)",
  borderRadius: "6px",
  padding: "0.4rem 0.9rem",
  fontSize: "0.85rem",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Onboard form state.
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(ROLE_OPTIONS[5]); // dev by default
  const [description, setDescription] = useState("");
  // Optional: email the invitee the join link + one-time secret (the backend
  // sends it via Resend/Graph and emits agent.invite_emailed).
  const [inviteEmail, setInviteEmail] = useState("");
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
    // Redirect unauthenticated users; never render a blank state. Same guard
    // every authenticated dashboard page uses (see /admin/benchmark).
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/agents");
      return;
    }
    void load();
  }, [router, load]);

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
          ...(inviteEmail.trim() ? { inviteEmail: inviteEmail.trim() } : {}),
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
      setInviteEmail("");
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

  /* Fleet overview, derived purely from the fetched roster, no invented
     metrics. Counts each lifecycle bucket, the agents with a live connection,
     and a small activity series (onboards per day over the last week) for the
     fleet-size sparkline, so the trend element only ever shows real data. */
  const fleet = useMemo(() => {
    const total = agents.length;
    let active = 0;
    let paused = 0;
    let invited = 0;
    let revoked = 0;
    let connected = 0;
    for (const a of agents) {
      if (a.state === "active") active += 1;
      else if (a.state === "paused") paused += 1;
      else if (a.state === "invited") invited += 1;
      else if (a.state === "revoked") revoked += 1;
      if (a.connections && a.connections.length > 0) connected += 1;
    }
    // Onboards per day over the trailing 7 days (oldest → newest), for the
    // fleet-size sparkline. Built from createdAt only; empty roster → zeros.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    for (const a of agents) {
      const t = new Date(a.createdAt).getTime();
      if (Number.isNaN(t)) continue;
      const ago = Math.floor((now - t) / day);
      if (ago >= 0 && ago < 7) buckets[6 - ago] += 1;
    }
    return { total, active, paused, invited, revoked, connected, trend: buckets };
  }, [agents]);

  return (
    <div
      data-testid="admin-agents-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "1100px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <SectionHeader
        as="h1"
        eyebrow="OGIAM · governed AI principals"
        title="Agent fleet"
        subtitle="These are AI principals, governed by OGIAM and onboarded like teammates. Each carries a role, an owner, and a lifecycle; every action it takes is gated and recorded in the AI Gateway decision log."
        testId="agents-section-header"
        actions={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            {NAV_LINKS.map((l) => (
              <Link
                key={l.testId}
                href={l.href}
                data-testid={l.testId}
                title={l.title}
                style={linkButtonStyle}
              >
                {l.label}
              </Link>
            ))}
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
        }
      />

      {/* Fleet overview metrics row. Every tile maps a field the roster already
          carries, no invented metrics. */}
      <GlassPanel
        glow="gold"
        padded
        testId="agents-fleet-overview"
        style={{ marginBottom: "1.5rem" }}
      >
        <ConsoleGrid minColWidth={180} testId="agents-fleet-metrics">
          <MetricTile
            testId="fleet-metric-total"
            value={fleet.total}
            label="Agents in fleet"
            kicker="Total principals"
            accent="var(--wp-gold, #f1c233)"
            sparkline={
              <Sparkline
                data={fleet.trend}
                accent="var(--wp-gold, #f1c233)"
                area
                ariaLabel="onboards over the last 7 days"
                testId="fleet-trend-sparkline"
              />
            }
          />
          <MetricTile
            testId="fleet-metric-active"
            value={fleet.active}
            label="Active"
            kicker="Live + gated"
            accent={colorForStatus("active")}
          />
          <MetricTile
            testId="fleet-metric-paused"
            value={fleet.paused}
            label="Paused"
            kicker="Idle"
            accent={colorForStatus("paused")}
          />
          <MetricTile
            testId="fleet-metric-invited"
            value={fleet.invited}
            label="Invited"
            kicker="Awaiting join"
          />
          <MetricTile
            testId="fleet-metric-connected"
            value={fleet.connected}
            label="Connected"
            kicker="With a bound service"
            accent={colorForStatus("active")}
          />
        </ConsoleGrid>
      </GlassPanel>

      {/* One-time secret panel. Renders prominently after a successful onboard
          and is the only place the credential is ever shown. */}
      {secret && (
        <GlassPanel
          glow="blue"
          testId="agent-onboarding-secret"
          title={
            <span style={{ color: "var(--wp-success, #22c55e)" }}>
              {secret.agent.name} onboarded
            </span>
          }
          subtitle={
            <span data-testid="agent-onboarding-secret-warning">
              Shown once. Copy it now; it is the agent&apos;s onboarding
              credential and is never shown again.
            </span>
          }
          style={{ marginBottom: "1.5rem" }}
        >
          <div
            style={{
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
        </GlassPanel>
      )}

      {/* Onboard form. */}
      <GlassPanel
        title="Onboard an agent"
        subtitle="Mint a governed identity for a new AI principal. The one-time secret is shown once on success."
        style={{ marginBottom: "1.75rem" }}
      >
        <form data-testid="agent-onboard-form" onSubmit={(e) => void onboard(e)}>
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
          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>
              Invite by email (optional)
            </span>
            <input
              data-testid="agent-onboard-invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com sends the join link + one-time secret"
              style={{
                padding: "0.5rem 0.7rem",
                fontSize: "0.88rem",
                background: "var(--wp-dark-surface2, #1a1a1a)",
                color: "var(--wp-text, #eee)",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: "6px",
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
      </GlassPanel>

      <SectionHeader
        title="Fleet roster"
        subtitle="Each card is one principal. Open a card to see its full identity, gate decisions, and bound services."
        testId="agents-roster-header"
      />

      {error && (
        <GlassPanel testId="agents-error-panel" style={{ marginBottom: "1rem" }}>
          <div
            data-testid="agents-error"
            style={{
              color: "var(--wp-error, #ef4444)",
              fontSize: "0.9rem",
            }}
          >
            {error}
          </div>
        </GlassPanel>
      )}

      {!error && loading && agents.length === 0 && (
        <GlassPanel testId="agents-loading">
          <div style={{ color: "var(--wp-text-dim, #aaa)", fontSize: "0.9rem" }}>
            Loading the fleet...
          </div>
        </GlassPanel>
      )}

      {!error && !loading && agents.length === 0 && (
        <GlassPanel testId="agents-empty-panel">
          <div
            data-testid="agents-empty"
            style={{
              textAlign: "center",
              color: "var(--wp-text-muted, #6b7280)",
              fontSize: "0.9rem",
              padding: "0.5rem 0",
            }}
          >
            No agent principals yet. Onboard one above to give an AI actor a
            governed identity.
          </div>
        </GlassPanel>
      )}

      {agents.length > 0 && (
        <div data-testid="agents-roster">
          <ConsoleGrid minColWidth={320} testId="agents-roster-grid">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/admin/agents/${a.id}`}
                data-testid={`agent-row-${a.id}`}
                style={{ textDecoration: "none", color: "inherit", display: "block" }}
              >
                <GlassPanel
                  padded
                  style={{ height: "100%", cursor: "pointer" }}
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
                    <div style={{ fontSize: "0.98rem", color: "var(--wp-text, #eee)", minWidth: 0 }}>
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
                    <StatusPill
                      status={statusForState(a.state)}
                      label={a.state}
                      size="md"
                      testId={`agent-state-chip-${a.id}`}
                    />
                  </div>

                  <div
                    style={{
                      marginTop: "0.5rem",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                      fontSize: "0.78rem",
                      color: "var(--wp-text-muted, #6b7280)",
                    }}
                  >
                    <span>owner: {a.ownerUserId ?? "unassigned"}</span>
                    <span title={a.createdAt}>{relativeTime(a.createdAt)}</span>
                  </div>

                  {a.description && (
                    <div
                      style={{
                        marginTop: "0.4rem",
                        fontSize: "0.8rem",
                        color: "var(--wp-text-dim, #aaa)",
                      }}
                    >
                      {a.description}
                    </div>
                  )}

                  {/* Bound services: the systems this agent operates, rendered
                      as small chips so the roster shows at a glance which agent
                      is a Salesforce / Jira / ... agent. A muted hint stands in
                      when the agent has nothing connected yet. */}
                  {a.connections && a.connections.length > 0 ? (
                    <div
                      data-testid={`agent-services-${a.id}`}
                      style={{
                        marginTop: "0.6rem",
                        display: "flex",
                        gap: "0.35rem",
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      {a.connections.map((conn) => (
                        <span
                          key={conn}
                          style={{
                            padding: "0.1rem 0.5rem",
                            borderRadius: "10px",
                            fontSize: "0.7rem",
                            fontWeight: 600,
                            fontFamily: "var(--wp-mono, monospace)",
                            background: "rgba(34,197,94,0.12)",
                            color: "var(--wp-success, #22c55e)",
                            border: "1px solid var(--wp-success, #22c55e)",
                          }}
                        >
                          {conn}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div
                      data-testid={`agent-services-${a.id}`}
                      style={{
                        marginTop: "0.6rem",
                        fontSize: "0.72rem",
                        color: "var(--wp-text-muted, #6b7280)",
                        fontStyle: "italic",
                      }}
                    >
                      no service connected
                    </div>
                  )}

                  <div
                    aria-hidden
                    style={{
                      marginTop: "0.7rem",
                      fontSize: "0.76rem",
                      fontWeight: 600,
                      color: "var(--wp-gold, #f1c233)",
                    }}
                  >
                    Open agent →
                  </div>
                </GlassPanel>
              </Link>
            ))}
          </ConsoleGrid>
        </div>
      )}
    </div>
  );
}
