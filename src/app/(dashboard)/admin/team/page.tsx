"use client";

/**
 * /admin/team — CTO/CEO live view of team-onboarding status.
 *
 * Shipped 2026-05-20 for the kickoff. Auto-refreshes every 10 sec so
 * the CTO can watch teammates sign in during the call.
 *
 * Three sections:
 *   - Summary chips (total / accepted / recently active / pending)
 *   - Members table (live sign-in status)
 *   - Pending invites (sent, not yet accepted)
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login: string | null;
  accepted: boolean;
  recently_active: boolean;
  newly_onboarded: boolean;
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: string;
  expires_at: string | null;
  hours_pending: number;
}

interface TeamStatus {
  summary: {
    total_members: number;
    accepted: number;
    recently_active: number;
    newly_onboarded: number;
    pending_invites: number;
  };
  members: Member[];
  pending_invites: PendingInvite[];
  fetched_at: string;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
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

export default function AdminTeamPage() {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/team-status");
      if (!res.ok) {
        if (res.status === 403) setError("You don't have permission to view team status.");
        else setError(`Could not load (HTTP ${res.status}).`);
        return;
      }
      const body = (await res.json()) as TeamStatus;
      setStatus(body);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div
      data-testid="admin-team-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "1100px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.25rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          Team status
        </h1>
        {status && (
          <div style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)" }}>
            Auto-refreshing every 10s · last fetched {relativeTime(status.fetched_at)}
          </div>
        )}
      </div>
      <p style={{ color: "var(--wp-text-dim, #aaa)", margin: "0 0 1.5rem 0", fontSize: "0.9rem" }}>
        Who&apos;s on the team, who&apos;s accepted, and who&apos;s signed in within the last 15 minutes.
      </p>

      {error && (
        <div
          data-testid="admin-team-error"
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

      {loading && !status && (
        <div style={{ color: "var(--wp-text-muted, #6b7280)" }}>Loading…</div>
      )}

      {status && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1.5rem" }} data-testid="admin-team-summary">
            <Stat label="Total members" value={status.summary.total_members} />
            <Stat label="Accepted" value={status.summary.accepted} />
            <Stat label="Signed in (15m)" value={status.summary.recently_active} highlight />
            <Stat label="New (24h)" value={status.summary.newly_onboarded} />
            <Stat label="Pending invites" value={status.summary.pending_invites} />
          </div>

          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>Members</h2>
          {status.members.length === 0 ? (
            <div style={{ padding: "1rem", color: "var(--wp-text-muted, #6b7280)" }}>No team members yet.</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, marginBottom: "1.5rem" }} data-testid="admin-team-members">
              {status.members.map((m) => (
                <li
                  key={m.id}
                  data-testid={`admin-team-member-${m.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.75rem 1rem",
                    marginBottom: "0.4rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    border: `1px solid ${m.recently_active ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
                    borderRadius: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    aria-label={m.recently_active ? "signed in recently" : "not signed in recently"}
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: m.recently_active ? "#4ade80" : m.accepted ? "#6b7280" : "#ef4444",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                      <strong style={{ color: "var(--wp-text, #eee)" }}>{m.name || m.email}</strong>
                      <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)" }}>
                        {m.email}
                      </span>
                      <span style={{ fontSize: "0.7rem", textTransform: "uppercase", color: "var(--wp-text-muted, #6b7280)" }}>
                        {m.role}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)", marginTop: "0.2rem" }}>
                      {m.accepted ? `last seen ${relativeTime(m.last_login)}` : "never signed in"}
                      {!m.is_active && " · disabled"}
                      {m.newly_onboarded && " · new today"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ fontSize: "1rem", margin: "1.5rem 0 0.5rem 0", color: "var(--wp-text-dim, #aaa)" }}>Pending invites</h2>
          {status.pending_invites.length === 0 ? (
            <div style={{ padding: "1rem", color: "var(--wp-text-muted, #6b7280)" }}>No pending invites.</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="admin-team-pending">
              {status.pending_invites.map((i) => (
                <li
                  key={i.id}
                  data-testid={`admin-team-pending-${i.id}`}
                  style={{
                    padding: "0.75rem 1rem",
                    marginBottom: "0.4rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    border: "1px dashed var(--wp-dark-border, #333)",
                    borderRadius: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ color: "var(--wp-text, #eee)" }}>{i.email}</strong>
                      <span style={{ marginLeft: "0.5rem", fontSize: "0.7rem", textTransform: "uppercase", color: "var(--wp-text-muted, #6b7280)" }}>
                        {i.role}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: i.hours_pending > 24 ? "var(--wp-error, #ef4444)" : "var(--wp-text-muted, #6b7280)" }}>
                      pending {i.hours_pending}h
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div
      style={{
        padding: "0.75rem 1rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: `1px solid ${highlight ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
        borderRadius: "8px",
      }}
    >
      <div style={{ fontSize: "0.7rem", color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 600, color: highlight ? "var(--wp-gold, #f1c233)" : "var(--wp-text, #eee)", marginTop: "0.2rem" }}>
        {value}
      </div>
    </div>
  );
}
