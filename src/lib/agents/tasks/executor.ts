/**
 * Agent task executor: run an assigned task as a governed multi-step plan.
 *
 * For each planned step the executor dispatches the instruction through the
 * assistant tool dispatcher AS THE AGENT, so the OGIAM gate runs in enforce mode
 * and attributes every step to the agent's identity. A step the gate refuses
 * (deny or escalate) stops the run and escalates to the agent's human owner for
 * approval, which is the human-in-the-loop control. The whole thing is bounded
 * (the planner caps steps) and never throws into the caller.
 *
 * The dispatcher and the notifier are injected so the loop is unit testable
 * without a database, an LLM, or the notifications layer.
 */

import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { notify } from "@/lib/notifications/in-app";
import { trackEvent } from "@/lib/analytics";
import {
  findPromotedProcedure,
  recordLearnedProcedure,
} from "@/lib/agents/memory/store";
import { getPlanner } from "./planner";
import type { TaskStatus, TaskStep } from "./types";

export interface ExecutableTask {
  id: string;
  goal: string;
  agentId: string;
  role: string;
  workspaceId: string;
  ownerUserId: string;
}

type DispatchFn = typeof tryDispatchTool;
type NotifyFn = typeof notify;
type LookupFn = typeof findPromotedProcedure;
type RecordFn = typeof recordLearnedProcedure;

export interface ExecutorDeps {
  dispatch?: DispatchFn;
  notifyOwner?: NotifyFn;
  /** Inheritance: find a promoted procedure for this goal. */
  lookupProcedure?: LookupFn;
  /** Learning: record the plan a succeeded task ran. */
  recordProcedure?: RecordFn;
}

export interface RunResult {
  status: TaskStatus;
  steps: TaskStep[];
  resultSummary: string;
  /** True when the plan was inherited from shared memory (no re-exploration). */
  inherited: boolean;
}

function truncate(s: string, n = 240): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** True when a dispatch failure is the OGIAM enforce gate refusing the step. */
function isGateBlock(result: { ok: boolean; code?: string; message?: string }): boolean {
  return (
    !result.ok &&
    result.code === "capability" &&
    /OGIAM/.test(result.message ?? "")
  );
}

export async function runAgentTask(
  task: ExecutableTask,
  deps: ExecutorDeps = {},
): Promise<RunResult> {
  const dispatch = deps.dispatch ?? tryDispatchTool;
  const notifyOwner = deps.notifyOwner ?? notify;
  const lookupProcedure = deps.lookupProcedure ?? findPromotedProcedure;
  const recordProcedure = deps.recordProcedure ?? recordLearnedProcedure;

  // Inheritance: reuse a promoted procedure for this goal instead of
  // re-exploring. Best effort: a memory miss or failure falls back to planning.
  let inherited = false;
  let instructions: string[];
  try {
    const prior = await lookupProcedure(task.workspaceId, task.goal, task.agentId);
    if (prior && prior.plan.length > 0) {
      instructions = prior.plan.map((p) => p.instruction);
      inherited = true;
    } else {
      instructions = getPlanner().plan(task.goal);
    }
  } catch {
    instructions = getPlanner().plan(task.goal);
  }

  const steps: TaskStep[] = [];
  let status: TaskStatus = "running";
  let blocked = false;

  const agentCtx = {
    userId: task.agentId,
    userRole: task.role,
    workspaceId: task.workspaceId,
    agentPrincipal: {
      agentId: task.agentId,
      role: task.role,
      workspaceId: task.workspaceId,
      ownerUserId: task.ownerUserId,
    },
  };

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    let res;
    try {
      res = await dispatch(instruction, agentCtx);
    } catch (err) {
      steps.push({ index: i, instruction, tool: null, outcome: "error", detail: truncate((err as Error).message) });
      status = "failed";
      break;
    }

    if (res === null) {
      steps.push({ index: i, instruction, tool: null, outcome: "no_match", detail: "no tool matched this instruction" });
      continue;
    }

    const r = res.result;
    if (isGateBlock(r)) {
      steps.push({ index: i, instruction, tool: res.tool, outcome: "blocked", detail: truncate((r as { message: string }).message) });
      blocked = true;
      // Escalate to the accountable human owner for approval.
      try {
        await notifyOwner({
          userId: task.ownerUserId,
          category: "agent",
          priority: "high",
          title: "Agent action needs your approval",
          body: `Agent ${task.agentId} was stopped on: ${truncate(instruction, 120)}`,
          actionUrl: `/admin/agents/${task.agentId}`,
          actionLabel: "Review agent",
          source: "agent_task",
          sourceId: task.id,
          metadata: { agent_id: task.agentId, task_id: task.id, step: i },
          dedup: true,
        });
      } catch {
        /* escalation is best effort; the block already stands */
      }
      break;
    }

    if (r.ok) {
      steps.push({ index: i, instruction, tool: res.tool, outcome: "ran", detail: truncate((r as { answer: string }).answer) });
    } else {
      steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate((r as { message: string }).message) });
    }
  }

  if (status !== "failed") status = blocked ? "blocked" : "succeeded";

  // Learning: a freshly-explored, fully-successful plan becomes a candidate
  // procedure (the safety check inside recordProcedure decides if it is shareable
  // and never lets an unsafe plan be inherited). We do not re-record an inherited
  // plan. Best effort: learning never breaks the task.
  if (status === "succeeded" && !inherited) {
    try {
      await recordProcedure({
        workspaceId: task.workspaceId,
        goal: task.goal,
        plan: steps.map((s) => ({ instruction: s.instruction, tool: s.tool })),
        learnedByAgent: task.agentId,
        sourceTaskId: task.id,
      });
    } catch {
      /* learning is best effort; the task already ran */
    }
  }

  const ran = steps.filter((s) => s.outcome === "ran").length;
  const resultSummary = blocked
    ? `Stopped for approval after ${ran} step(s).`
    : status === "failed"
      ? "Failed during execution."
      : `Completed ${ran} of ${steps.length} step(s).`;

  trackEvent("agent.task_completed", task.agentId, task.role, {
    agent_id: task.agentId,
    task_id: task.id,
    status,
    step_count: steps.length,
    ran_count: ran,
    blocked,
  });

  return { status, steps, resultSummary, inherited };
}
