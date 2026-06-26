"use client";

/**
 * Read-only human-in-the-loop HISTORY for one agent: the recent DECIDED write
 * approvals (approved / rejected / executed / expired). The pending queue
 * (ApprovalList) is transient and usually empty, which made the section look
 * dead; this surfaces the actual approval activity over time so it always shows
 * what the agent has done through the gate.
 *
 * Auth: fetchWithRefresh. Backed by GET /api/admin/agents/approvals?agentId&history=1.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { summarize, type PendingApproval } from "@/components/agents/ApprovalList";

type Decided = PendingApproval & {
  status: "approved" | "rejected" | "executed" | "expired" | "pending";
  decidedAt?: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  executed: "var(--wp-success, #22c55e)",
  approved: "var(--wp-success, #22c55e)",
  rejected: "var(--wp-error, #ef4444)",
  expired: "var(--wp-text-dim, #aaa)",
};

const WRITE_LABEL: Record<string, string> = {
  create_external_record: "Create record",
  update_external_record: "Update record",
};

export default function ApprovalHistory({ agentId }: { agentId: string }) {
  const [history, setHistory] = useState<Decided[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/approvals?agentId=${agentId}&history=1`);
      if (!res.ok) return;
      const data = (await res.json()) as { history?: Decided[] };
      setHistory(data.history ?? []);
    } catch {
      /* history is supplementary; a fetch failure leaves it empty, never blocks the page. */
    } finally {
      setLoaded(true);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing decided yet: stay quiet (the pending list's own empty state speaks).
  if (!loaded || history.length === 0) return null;

  return (
    <div data-testid="agent-approvals-history" style={{ marginTop: "0.9rem" }}>
      <div style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "0.4rem" }}>
        Recent decisions
      </div>
      {history.map((h) => (
        <div
          key={h.id}
          data-testid={`approval-history-${h.id}`}
          style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", padding: "0.5rem 0.7rem", marginBottom: "0.4rem", background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "0.4rem" }}
        >
          <span style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: STATUS_COLOR[h.status] ?? "var(--wp-text-dim, #aaa)" }}>
            {h.status}
          </span>
          <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #6b7280)" }}>
            {WRITE_LABEL[h.tool] ?? h.tool}
          </span>
          <span style={{ fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>{summarize(h.params)}</span>
          <span style={{ flex: 1 }} />
          {h.decidedAt && (
            <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim, #aaa)" }}>
              {new Date(h.decidedAt).toLocaleString()}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
