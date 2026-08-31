/**
 * Hold an agent's write until a human decides.
 *
 * WHY THIS FILE EXISTS. agent.write_pending_approval, agent.write_approved and
 * agent.write_executed had never fired. Not once, in ninety days, while
 * /playbook told clients the product holds an agent's write until a human
 * approves it. The approvals store was written and tested; nothing outside its
 * own tests ever called it. The sixth control this month found declared,
 * described accurately, and wired to nothing.
 *
 * A control that has never executed is not a control. It is a paragraph.
 *
 * PER AGENT, NOT GLOBAL. Seventy-three agent tasks have already completed here.
 * Gating every write behind a human would stop them dead and teach everybody to
 * switch the gate off, which is worse than not having one. An agent trusted to
 * file a task keeps filing tasks. An agent pointed at a client's CRM does not,
 * and that is a decision somebody should make per agent.
 *
 * ONLY WRITES. A read that needed approval would make the gate hated and teach
 * people to grant blanket approval, which is how a control becomes a rubber
 * stamp.
 */

import { query } from "@/lib/db";
import { createPendingApproval } from "./store";

/** Methods that change something on the other side. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteOperation(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Whether this agent's writes are held.
 *
 * FAILS CLOSED ON AN UNREADABLE ANSWER. Everywhere else in this codebase an
 * unreadable source degrades to "we do not know" and carries on, because the
 * cost is a missing number. Here the cost is an unapproved write against a
 * client's system, so not knowing whether approval was required is treated as
 * requiring it. A held write is recoverable in one click; an executed one is
 * not.
 */
export async function requiresWriteApproval(
  agentId: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const { rows } = await query<{ requires_write_approval: boolean }>(
      `SELECT requires_write_approval FROM instinct_agents
        WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    /* No such agent in this workspace is not "no approval needed", it is a
       question we could not answer about an actor we do not recognize. */
    if (rows.length === 0) return true;
    return rows[0].requires_write_approval === true;
  } catch {
    return true;
  }
}

export interface HeldWrite {
  approvalId: string;
  detail: string;
}

/**
 * Capture a write as pending, or return null when it may proceed.
 *
 * Returns the id so the caller can tell somebody WHICH approval is waiting.
 * "Waiting for approval" with no handle is a dead end for whoever has to
 * approve it.
 */
export async function holdWriteForApproval(args: {
  agentId: string;
  workspaceId: string;
  ownerUserId: string;
  operationId: string;
  method: string;
  params: Record<string, unknown>;
  capability: string;
}): Promise<HeldWrite | null> {
  if (!isWriteOperation(args.method)) return null;
  if (!(await requiresWriteApproval(args.agentId, args.workspaceId))) return null;

  const approvalId = await createPendingApproval({
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    ownerUserId: args.ownerUserId,
    tool: args.operationId,
    params: args.params,
    capability: args.capability,
  });

  if (!approvalId) {
    /* The capture itself failed. Refusing is the only safe answer: proceeding
       would execute the write with no record that anybody allowed it, which is
       the exact situation the gate exists to prevent. */
    return {
      approvalId: "",
      detail: `${args.operationId} was not run: it needs approval and the approval could not be recorded.`,
    };
  }

  return {
    approvalId,
    detail: `${args.operationId} is waiting for approval (${approvalId}). It has not run.`,
  };
}
