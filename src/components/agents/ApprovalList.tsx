"use client";

/**
 * Shared human-in-the-loop write-approval surface.
 *
 * A governed agent that proposes a CRM/connector write cannot mutate anything
 * until a human approves it. This component renders the captured actions (tool +
 * validated fields) with approve/reject; approving runs the EXACT captured action
 * on the owner's behalf, re-gated and audited.
 *
 * One implementation, two mounts (DRY):
 *   - /admin/agents/approvals      -> the whole-workspace queue (endpoint w/o agentId)
 *   - /admin/agents/[id]           -> just this agent's pending writes (?agentId=…)
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). The backing route is capability-gated (settings.manage_team).
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

export interface PendingApproval {
  id: string;
  agentId: string;
  ownerUserId: string;
  tool: string;
  params: Record<string, unknown>;
  capability: string;
  decisionSeq: number | null;
  createdAt: string;
}

const WRITE_LABEL: Record<string, string> = {
  create_external_record: "Create record",
  update_external_record: "Update record",
};

/** Compact, human-readable summary of the captured write (no secrets — field
 *  values only). "Contact · Name=Jane Doe, Email=jane@acme.com". */
export function summarize(params: Record<string, unknown>): string {
  const objectType = typeof params.objectType === "string" ? params.objectType : "record";
  const fields = (params.fields && typeof params.fields === "object" ? params.fields : {}) as Record<string, unknown>;
  const pairs = Object.entries(fields)
    .filter(([k]) => !k.endsWith("_hint"))
    .slice(0, 6)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  const head = objectType.charAt(0).toUpperCase() + objectType.slice(1);
  return pairs ? `${head} · ${pairs}` : head;
}

export function ApprovalRow({
  entry,
  showAgent = true,
  onDecide,
}: {
  entry: PendingApproval;
  showAgent?: boolean;
  onDecide: (id: string, action: "approve" | "reject") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(action: "approve" | "reject") {
    setBusy(action);
    setRowError(null);
    try {
      await onDecide(entry.id, action);
    } catch (e) {
      setRowError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-testid={`approval-row-${entry.id}`}
      style={{
        padding: "0.85rem 1rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "0.5rem",
        marginBottom: "0.6rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--wp-gold, #f1c233)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {WRITE_LABEL[entry.tool] ?? entry.tool}
        </span>
        <span data-testid={`approval-summary-${entry.id}`} style={{ fontSize: "0.95rem", color: "var(--wp-text, #eee)" }}>
          {summarize(entry.params)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid={`approve-${entry.id}`}
          disabled={busy !== null}
          onClick={() => void run("approve")}
          style={{ padding: "0.35rem 0.8rem", borderRadius: "0.4rem", border: "none", cursor: "pointer", fontWeight: 600, color: "#0b0b0c", background: "var(--wp-success, #22c55e)" }}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          data-testid={`reject-${entry.id}`}
          disabled={busy !== null}
          onClick={() => void run("reject")}
          style={{ padding: "0.35rem 0.8rem", borderRadius: "0.4rem", cursor: "pointer", color: "var(--wp-error, #ef4444)", background: "transparent", border: "1px solid var(--wp-error, #ef4444)" }}
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {showAgent && (
        <div style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}>
          Proposed by agent <strong style={{ color: "var(--wp-text-dim, #aaa)" }}>{entry.agentId}</strong>
          {" "}on behalf of <strong style={{ color: "var(--wp-text-dim, #aaa)" }}>{entry.ownerUserId}</strong>
        </div>
      )}
      {rowError && (
        <div data-testid={`approval-error-${entry.id}`} style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
          {rowError}
        </div>
      )}
    </div>
  );
}

/**
 * Self-contained list: loads pending approvals from `endpoint`, renders rows,
 * and decides in place (decided rows drop out). Reused by the workspace queue
 * and the per-agent detail section.
 *
 * @param endpoint    GET source (e.g. "/api/admin/agents/approvals" or
 *                    "/api/admin/agents/approvals?agentId=<id>").
 * @param showAgent   Show the "proposed by agent X" line (off on the detail page,
 *                    where the agent is already the page subject).
 * @param emptyText   Copy for the empty state.
 * @param testIdPrefix Namespaces the list/empty test ids so two mounts don't collide.
 * @param onCountChange Notifies the parent of the current pending count (badges).
 */
export default function ApprovalList({
  endpoint,
  showAgent = true,
  emptyText = "No pending writes. Nothing is awaiting your approval.",
  testIdPrefix = "approvals",
  onCountChange,
}: {
  endpoint: string;
  showAgent?: boolean;
  emptyText?: string;
  testIdPrefix?: string;
  onCountChange?: (n: number) => void;
}) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(endpoint);
      if (!res.ok) throw new Error(`Failed to load approvals (HTTP ${res.status})`);
      const data = (await res.json()) as { approvals?: PendingApproval[] };
      const list = data.approvals ?? [];
      setApprovals(list);
      onCountChange?.(list.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (id: string, action: "approve" | "reject") => {
      const res = await fetchWithRefresh(`/api/admin/agents/approvals/${id}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Action failed (HTTP ${res.status})`);
      }
      // Decided rows are no longer pending — drop them in place + update count.
      setApprovals((prev) => {
        const next = prev.filter((a) => a.id !== id);
        onCountChange?.(next.length);
        return next;
      });
    },
    [onCountChange],
  );

  if (loading) return <p data-testid={`${testIdPrefix}-loading`} style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>;
  if (error) return <p data-testid={`${testIdPrefix}-error`} style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>;
  if (approvals.length === 0) return <p data-testid={`${testIdPrefix}-empty`} style={{ color: "var(--wp-text-dim, #aaa)" }}>{emptyText}</p>;

  return (
    <div data-testid={`${testIdPrefix}-list`}>
      {approvals.map((a) => (
        <ApprovalRow key={a.id} entry={a} showAgent={showAgent} onDecide={decide} />
      ))}
    </div>
  );
}
