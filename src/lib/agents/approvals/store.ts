/**
 * Agent write-approval store (human-in-the-loop). Captures a governed agent's
 * proposed MUTATION (the exact tool + validated params + the OGIAM decision it
 * passed) so an owner/admin can approve it, after which the captured action
 * executes once, re-gated. Workspace-scoped throughout (queries always filter by
 * workspace_id). Every state change emits a canonical beyond-style event so the
 * learning loop sees the full approve/reject funnel (no data lost).
 */
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "expired";

export interface PendingApproval {
  id: string;
  workspaceId: string;
  agentId: string;
  ownerUserId: string;
  tool: string;
  params: Record<string, unknown>;
  capability: string;
  decisionSeq: number | null;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  outcome: Record<string, unknown> | null;
}

/** Captured proposals expire so a stale write can't be approved days later. */
export const APPROVAL_TTL_HOURS = 24;

type Row = {
  id: string; workspace_id: string; agent_id: string; owner_user_id: string;
  tool: string; params: Record<string, unknown>; capability: string;
  decision_seq: string | null; status: string; created_at: string; expires_at: string;
  decided_by: string | null; decided_at: string | null; outcome: Record<string, unknown> | null;
};
const COLS =
  "id, workspace_id, agent_id, owner_user_id, tool, params, capability, decision_seq, status, created_at, expires_at, decided_by, decided_at, outcome";

function toApproval(r: Row): PendingApproval {
  return {
    id: r.id, workspaceId: r.workspace_id, agentId: r.agent_id, ownerUserId: r.owner_user_id,
    tool: r.tool, params: r.params, capability: r.capability,
    decisionSeq: r.decision_seq != null ? Number(r.decision_seq) : null,
    status: r.status as ApprovalStatus, createdAt: r.created_at, expiresAt: r.expires_at,
    decidedBy: r.decided_by, decidedAt: r.decided_at, outcome: r.outcome,
  };
}

async function emit(name: Parameters<typeof trackEvent>[0], actorId: string, role: string, props: Record<string, string | number | boolean>): Promise<void> {
  try { trackEvent(name, actorId, role, props); } catch (err) { console.error(`[approvals] emit failed (${name})`, (err as Error).message); }
}

/** Capture a proposed agent mutation as a pending approval. Best-effort: a write
 *  with no captured approval simply stays blocked (safe). Returns the id or null. */
export async function createPendingApproval(input: {
  workspaceId: string; agentId: string; ownerUserId: string;
  tool: string; params: Record<string, unknown>; capability: string; decisionSeq?: number | null;
}): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO instinct_agent_pending_approvals
         (workspace_id, agent_id, owner_user_id, tool, params, capability, decision_seq, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7, now() + ($8 || ' hours')::interval)
       RETURNING id`,
      [input.workspaceId, input.agentId, input.ownerUserId, input.tool,
       JSON.stringify(input.params), input.capability, input.decisionSeq ?? null, String(APPROVAL_TTL_HOURS)],
    );
    const id = rows[0]?.id ?? null;
    if (id) await emit("agent.write_pending_approval", input.agentId, "agent", {
      approval_id: id, workspace_id: input.workspaceId, owner_user_id: input.ownerUserId, tool: input.tool,
    });
    return id;
  } catch (err) {
    console.error("[approvals] createPendingApproval failed:", (err as Error).message);
    return null;
  }
}

export async function getPendingApproval(id: string, workspaceId: string): Promise<PendingApproval | null> {
  const { rows } = await safeQuery<Row>(
    `SELECT ${COLS} FROM instinct_agent_pending_approvals WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ? toApproval(rows[0]) : null;
}

export async function listPendingApprovals(
  workspaceId: string,
  agentId?: string,
): Promise<PendingApproval[]> {
  // Optional agentId narrows the queue to a single agent (the agent detail page
  // surfaces just that agent's pending writes); omit it for the workspace queue.
  const { rows } = await safeQuery<Row>(
    `SELECT ${COLS} FROM instinct_agent_pending_approvals
       WHERE workspace_id = $1 AND status = 'pending' AND expires_at > now()
         AND ($2::text IS NULL OR agent_id = $2)
       ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, agentId ?? null],
  );
  return rows.map(toApproval);
}

/**
 * Recent DECIDED approvals for one agent (approved / rejected / executed /
 * expired) — the human-in-the-loop HISTORY, so the agent's approval activity is
 * visible even when nothing is pending right now. Newest decision first.
 */
export async function listAgentApprovalHistory(
  workspaceId: string,
  agentId: string,
  limit = 15,
): Promise<PendingApproval[]> {
  const { rows } = await safeQuery<Row>(
    `SELECT ${COLS} FROM instinct_agent_pending_approvals
       WHERE workspace_id = $1 AND agent_id = $2 AND status <> 'pending'
       ORDER BY COALESCE(decided_at, created_at) DESC
       LIMIT $3`,
    [workspaceId, agentId, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map(toApproval);
}

/** Atomically move a pending approval to approved/rejected. The WHERE status =
 *  'pending' guard makes double-decide (race / replay) impossible. Returns the
 *  updated row, or null if it was not pending (already decided / expired / gone). */
export async function decidePendingApproval(
  id: string, workspaceId: string, decidedBy: string, decision: "approved" | "rejected",
): Promise<PendingApproval | null> {
  const { rows } = await query<Row>(
    `UPDATE instinct_agent_pending_approvals
        SET status = $4, decided_by = $3, decided_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = 'pending' AND expires_at > now()
      RETURNING ${COLS}`,
    [id, workspaceId, decidedBy, decision],
  );
  const updated = rows[0] ? toApproval(rows[0]) : null;
  if (updated) await emit(
    decision === "approved" ? "agent.write_approved" : "agent.write_rejected",
    updated.agentId, "agent",
    { approval_id: id, workspace_id: workspaceId, decided_by: decidedBy, tool: updated.tool },
  );
  return updated;
}

/** Record the outcome of executing an approved action and flip status to
 *  executed. Keeps the captured proposal as a durable audit record. */
export async function markApprovalExecuted(
  id: string, workspaceId: string, outcome: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `UPDATE instinct_agent_pending_approvals
          SET status = 'executed', outcome = $3::jsonb
        WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId, JSON.stringify(outcome)],
    );
    await emit("agent.write_executed", "system", "system", { approval_id: id, workspace_id: workspaceId, ok: outcome.ok === true });
  } catch (err) {
    console.error("[approvals] markApprovalExecuted failed:", (err as Error).message);
  }
}
