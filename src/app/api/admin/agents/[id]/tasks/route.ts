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
 * hash-chained audit ledger (agent.task_assigned). The task is then executed
 * inline AS the agent through the shared governed-execution helper so the UI
 * shows the real outcome immediately instead of an eternal "queued" row. The
 * same helper backs the agent runtime at POST /api/agents/run-tasks; the
 * executor it calls fires agent.task_completed and the learning hooks, so this
 * route never counts completion twice.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent } from "@/lib/agents/store";
import { createTask, listTasksForAgent } from "@/lib/agents/tasks/store";
import { executeTaskAsAgent } from "@/lib/agents/tasks/run-inline";
import {
  validateTaskTemplate,
  composeGuidance,
  type TaskSource,
} from "@/lib/agents/tasks/template";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { reviewPrompt } from "@/lib/agents/prompt-review";
import { trackEvent } from "@/lib/analytics";

const MAX_GOAL_LEN = 4000;

function resolveSource(raw: unknown): TaskSource {
  const s = (raw as Record<string, unknown>)?.source;
  return s === "detail_page" || s === "chat_widget" || s === "deploy_gate" ? s : "api";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const workspace = auth.user.workspaceId ?? "default";

  /* Verify the agent exists and is active from the source of truth. Work must
     never be queued onto an agent that no longer holds its mandate (revoked) or
     has been suspended (paused): since the task now executes inline as the
     agent, an inactive principal must not run. Both inactive states are refused
     up front before createTask, so nothing is persisted onto a dead agent. */
  const agent = await getAgent(id, workspace);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }
  if (agent.state !== "active") {
    return NextResponse.json({ error: "agent_not_active" }, { status: 409 });
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  /* Two accepted shapes:
       - Template (control plane): { objective, successCriteria, context?,
         targetConnectionId?, source? }. objective -> goal (the plan); the rest
         is stored structured + composed into run-context guidance.
       - Legacy: { goal }. Still supported so any older caller keeps working. */
  let goal: string;
  let successCriteria: string | undefined;
  let context: string | undefined;
  let targetConnectionId: string | undefined;
  let guidance: string | undefined;

  if (raw && typeof raw.objective === "string") {
    const parsed = validateTaskTemplate(raw);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: "invalid_input", detail: parsed.error },
        { status: 400 },
      );
    }
    goal = parsed.value.objective;
    successCriteria = parsed.value.successCriteria;
    context = parsed.value.context;
    targetConnectionId = parsed.value.targetConnectionId;
    guidance = composeGuidance(parsed.value);
  } else {
    goal = typeof raw?.goal === "string" ? (raw.goal as string).trim() : "";
    if (!goal) {
      return NextResponse.json(
        { error: "invalid_input", detail: "objective is required" },
        { status: 400 },
      );
    }
    if (goal.length > MAX_GOAL_LEN) {
      return NextResponse.json(
        { error: "invalid_input", detail: `objective must be <= ${MAX_GOAL_LEN} chars` },
        { status: 400 },
      );
    }
  }

  /* THE AGENT ASKS BEFORE IT STARTS.
   *
   * reviewPrompt is deterministic, free, and already unit-tested. It names the
   * handful of facts whose absence causes an expensive round trip: where the
   * work has to run, how you would know it worked, what must not change, and
   * what already exists that should be reused.
   *
   * It shipped on 2026-08-02 as a panel on the Agent fleet page and was run
   * ZERO times in three days, on a page viewed 114 times — because nobody
   * writes a brief there. This is where a brief actually arrives, so the check
   * belongs here.
   *
   * ADVISORY, NOT A BLOCK. Refusing work because a sentence is missing would
   * make the agent unusable, and a gate people route around teaches them to
   * write less. The task is created either way; the questions ride back on the
   * response so the assignee sees them at the moment they can still answer.
   * That is what a colleague does with a thin brief.
   */
  const briefReview = reviewPrompt(goal);

  const task = await createTask({
    agentId: id,
    workspaceId: workspace,
    assignedBy: auth.user.id,
    assignedByRole: auth.user.role,
    goal,
    successCriteria,
    context,
    targetConnectionId,
    source: resolveSource(raw),
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

  /* Execute the task inline AS the agent through the shared governed-execution
     helper: it runs the OGIAM-enforced executor under the agent's identity,
     persists the terminal state, and (inside the executor) fires
     agent.task_completed plus the learning hooks exactly once. The returned row
     carries the terminal status + governed steps so the UI shows the real
     outcome instead of an eternal "queued". The helper never throws. */
  const completed = await executeTaskAsAgent(
    {
      id: agent.id,
      role: agent.role,
      ownerUserId: agent.ownerUserId,
      workspaceId: workspace,
    },
    { id: task.id, goal: task.goal, guidance },
  );

  /* What the brief left unsaid, and which fact it was.
   *
   * The questions go back to the caller so they are seen while the answer is
   * still cheap. The EVENT records only the dimensions that were missing and
   * how many — never the brief text, which can name a client. That is what
   * finally makes "which fact do we most often leave out" answerable; it could
   * not be answered before because the reviewer had never once been run. */
  if (briefReview.findings.length > 0) {
    trackEvent("agent.brief_reviewed", auth.user.id, auth.user.role, {
      agent_id: id,
      task_id: task.id,
      missing_count: briefReview.findings.length,
      dimensions: briefReview.findings.map((f) => f.dimension).sort().join(","),
      surface: "task_assignment",
    });
  }

  return NextResponse.json(
    {
      task: completed ?? task,
      /* Omitted entirely when the brief was complete: an empty array reads as
         "the check ran and found nothing", which is the same thing, but a
         missing key keeps a clean response clean. */
      ...(briefReview.findings.length > 0
        ? {
            briefReview: {
              headline: briefReview.headline,
              questions: briefReview.findings.map((f) => ({
                missing: f.missing,
                ask: f.ask,
              })),
            },
          }
        : {}),
    },
    { status: 201 },
  );
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
