"use client";

/**
 * /admin/agents/approvals — the human-in-the-loop write queue (whole workspace).
 *
 * A governed agent that proposes a write cannot mutate anything until a human
 * approves it here. The list + row + decide logic is the shared <ApprovalList>
 * (also mounted, scoped per-agent, on the agent detail page). This page is the
 * workspace-wide view; it lists every agent's pending writes.
 */

import Link from "next/link";
import ApprovalList from "@/components/agents/ApprovalList";

export default function AgentApprovalsPage() {
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

      <ApprovalList endpoint="/api/admin/agents/approvals" />
    </div>
  );
}
