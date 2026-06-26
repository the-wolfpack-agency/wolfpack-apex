"use client";

/**
 * /admin/agents/approvals — the human-in-the-loop write queue.
 *
 * A governed agent that proposes a CRM write (create/update a record) cannot
 * mutate anything until a human approves it here. Each row is the EXACT captured
 * action (tool + the validated fields); approving runs that action on the
 * owner's behalf, re-gated; rejecting drops it. This is what lets an agent
 * COMPLETE a workflow without ever acting unilaterally.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). The route is capability-gated (settings.manage_team) on the
 * API side.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface PendingApproval {
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

/** Compact, human-readable summary of the captured write (no secrets — CRM
 *  field values only). "Contact · Name=Jane Doe, Email=jane@acme.com". */
function summarize(params: Record<string, unknown>): string {
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

function ApprovalRow({
  entry,
  onDecide,
}: {
  entry: PendingApproval;
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
      <div style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}>
        Proposed by agent <strong style={{ color: "var(--wp-text-dim, #aaa)" }}>{entry.agentId}</strong>
        {" "}on behalf of <strong style={{ color: "var(--wp-text-dim, #aaa)" }}>{entry.ownerUserId}</strong>
      </div>
      {rowError && (
        <div data-testid={`approval-error-${entry.id}`} style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
          {rowError}
        </div>
      )}
    </div>
  );
}

export default function AgentApprovalsPage() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/agents/approvals");
      if (!res.ok) throw new Error(`Failed to load approvals (HTTP ${res.status})`);
      const data = (await res.json()) as { approvals?: PendingApproval[] };
      setApprovals(data.approvals ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(async (id: string, action: "approve" | "reject") => {
    const res = await fetchWithRefresh(`/api/admin/agents/approvals/${id}`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Action failed (HTTP ${res.status})`);
    }
    // Decided rows are no longer pending — drop them from the queue in place.
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return (
    <div data-testid="agent-approvals-page" style={{ padding: "1.5rem", maxWidth: 920, margin: "0 auto", color: "var(--wp-text, #eee)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Write approvals</h1>
        <span style={{ flex: 1 }} />
        <Link href="/admin/agents" data-testid="back-to-agents" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
          ← Agents
        </Link>
      </div>
      <p style={{ marginTop: 0, marginBottom: "1.2rem", fontSize: "0.9rem", color: "var(--wp-text-muted, #6b7280)" }}>
        Writes an agent proposes wait here. Approving runs the exact captured action on the owner&apos;s behalf, re-gated and audited; rejecting drops it. The agent never mutates anything on its own.
      </p>

      {loading ? (
        <p data-testid="approvals-loading" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>
      ) : error ? (
        <p data-testid="approvals-error" style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>
      ) : approvals.length === 0 ? (
        <p data-testid="approvals-empty" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No pending writes. Nothing is awaiting your approval.
        </p>
      ) : (
        <div data-testid="approvals-list">
          {approvals.map((a) => (
            <ApprovalRow key={a.id} entry={a} onDecide={decide} />
          ))}
        </div>
      )}
    </div>
  );
}
