/**
 * Agent task assignment surface (human-facing).
 *
 *   POST /api/admin/agents/[id]/tasks  : a human assigns work to an agent.
 *   GET  /api/admin/agents/[id]/tasks  : list the tasks assigned to the agent.
 *
 * Both are capability-gated on `settings.manage_team`: directing an autonomous
 * principal is a team-administration action, the same gate that mints and
 * governs agents elsewhere. The agent's existence and lifecycle state are read
 * from the DB (never inferred), so work can't be queued onto a revoked agent.
 *
 * Assignment is security-relevant, telling an autonomous principal what to do
 * on the team's behalf, so every successful POST is recorded in the
 * hash-chained audit ledger (agent.task_assigned). The agent runtime that
 * actually executes the queued work lives at POST /api/agents/run-tasks.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { createTask, listTasksForAgent } from "@/lib/agents/tasks/store";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const MAX_GOAL_LEN = 4000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const workspace = auth.user.workspaceId ?? "default";

  /* Verify the agent exists and is not revoked from the source of truth. Work
     must never be queued onto an agent that no longer holds its mandate. */
  const agent = await getAgent(id, workspace);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }
  if (agent.state === "revoked") {
    return NextResponse.json({ error: "agent_revoked" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as { goal?: unknown } | null;
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  if (!goal) {
    return NextResponse.json(
      { error: "invalid_input", detail: "goal is required" },
      { status: 400 },
    );
  }
  if (goal.length > MAX_GOAL_LEN) {
    return NextResponse.json(
      { error: "invalid_input", detail: `goal must be <= ${MAX_GOAL_LEN} chars` },
      { status: 400 },
    );
  }

  const task = await createTask({
    agentId: id,
    workspaceId: workspace,
    assignedBy: auth.user.id,
    assignedByRole: auth.user.role,
    goal,
  });

  /* Directing an autonomous principal is a security-relevant action, so it is
     hash-chained. recordAudit is best-effort and must not fail the request. */
  try {
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "agent.task_assigned",
      resourceType: "agent_task",
      resourceId: task.id,
      afterState: { agent_id: id },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[agent-task-assign audit]", (err as Error).message);
  }

  return NextResponse.json({ task }, { status: 201 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const workspace = auth.user.workspaceId ?? "default";

  const tasks = await listTasksForAgent(id, workspace);
  return NextResponse.json({ tasks }, { status: 200 });
}
