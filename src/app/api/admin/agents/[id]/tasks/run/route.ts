/**
 * POST /api/admin/agents/[id]/tasks/run : admin drain of an agent's backlog.
 *
 * A manager can kick off work that is already sitting "queued" on an agent
 * (assigned before inline execution existed, or queued by some other path)
 * without waiting for the agent's own runtime token to drain it. This claims
 * the agent's queued tasks and runs each one inline AS the agent through the
 * single shared governed-execution helper (executeTaskAsAgent), the same helper
 * that backs POST /api/agents/run-tasks and the assignment surface.
 *
 * Gated on `settings.manage_team` (directing an autonomous principal is a
 * team-administration action). The agent's existence and lifecycle state are
 * read from the source of truth: a missing agent is 404, a non-active
 * (paused / revoked / invited) agent is 409 agent_not_active and nothing runs,
 * since an inactive principal must not execute.
 *
 * The drain is bounded (MAX_DRAIN) so one request can never run an unbounded
 * backlog. The executor (inside the helper) fires agent.task_completed and the
 * learning hooks per task, so completion is counted there, not duplicated here;
 * this route only records the kickoff as agent.tasks_drained in the audit
 * ledger (best effort).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { claimNextQueuedTask, listTasksForAgent } from "@/lib/agents/tasks/store";
import { executeTaskAsAgent } from "@/lib/agents/tasks/run-inline";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

/** Upper bound on tasks drained per call so one request can't run unbounded. */
const MAX_DRAIN = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const workspace = auth.user.workspaceId ?? "default";

  /* Lifecycle is read from the source of truth, never inferred. A non-active
     agent must not execute its backlog. */
  const agent = await getAgent(id, workspace);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }
  if (agent.state !== "active") {
    return NextResponse.json({ error: "agent_not_active" }, { status: 409 });
  }

  const identity = {
    id: agent.id,
    role: agent.role,
    ownerUserId: agent.ownerUserId,
    workspaceId: workspace,
  };

  /* Claim and run each queued task inline as the agent, bounded so a backlog
     can never make one request run unbounded. The helper never throws: a bad
     task is recorded failed and the drain continues. */
  let ran = 0;
  for (let i = 0; i < MAX_DRAIN; i++) {
    const t = await claimNextQueuedTask(id, workspace);
    if (!t) break;
    await executeTaskAsAgent(identity, { id: t.id, goal: t.goal });
    ran++;
  }

  /* Kicking off an agent's backlog is security-relevant. Hash-chain it, best
     effort so the ledger can never fail the request. */
  try {
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "agent.tasks_drained",
      resourceType: "agent",
      resourceId: id,
      afterState: { agent_id: id, ran },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[agent-tasks-drain audit]", (err as Error).message);
  }

  const tasks = await listTasksForAgent(id, workspace);
  return NextResponse.json({ ran, tasks }, { status: 200 });
}
