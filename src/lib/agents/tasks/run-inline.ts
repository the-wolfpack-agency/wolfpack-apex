/**
 * Run one assigned task AS the agent and persist the outcome.
 *
 * This is the single source of truth for "execute a queued task under the
 * agent's own identity and write back the terminal state." Both the agent
 * runtime (POST /api/agents/run-tasks) and the human-facing assignment surface
 * (POST /api/admin/agents/[id]/tasks) call this so the inline-execution path is
 * defined once.
 *
 * The governed executor (runAgentTask) dispatches every step through the OGIAM
 * enforce gate under the agent principal, escalates a blocked step to the human
 * owner, records learned procedures, and fires agent.task_completed for the
 * learning loop. We do NOT duplicate any of that here: we hand the task to the
 * executor, persist the result through completeTask, and return the refreshed
 * row. The analytics/learning hooks stay inside the executor so completion is
 * counted exactly once.
 *
 * On a thrown executor or persistence error the task is best-effort marked
 * failed (so a caller never sees a task stuck "running") and the updated row is
 * returned. This never throws into the caller.
 */

import { runAgentTask, type ExecutorDeps } from "./executor";
import { completeTask, getTask } from "./store";
import type { AgentTask } from "./types";

export interface InlineAgentIdentity {
  id: string;
  role: string;
  ownerUserId: string;
  workspaceId: string;
}

export interface InlineTask {
  id: string;
  goal: string;
  /** Template guidance (success criteria, context, target) for the run. */
  guidance?: string;
}

/**
 * Execute a single task as the given agent and persist the result. Returns the
 * refreshed task row (terminal status + governed steps populated), or the input
 * task id reflected with a failed status if even the refresh read fails.
 */
export async function executeTaskAsAgent(
  agent: InlineAgentIdentity,
  task: InlineTask,
  deps?: ExecutorDeps,
): Promise<AgentTask | null> {
  try {
    const run = await runAgentTask(
      {
        id: task.id,
        goal: task.goal,
        agentId: agent.id,
        role: agent.role,
        workspaceId: agent.workspaceId,
        ownerUserId: agent.ownerUserId,
        guidance: task.guidance,
      },
      deps,
    );
    await completeTask(task.id, run.status, run.steps, run.resultSummary);
  } catch (err) {
    /* A thrown executor or persistence error must not leave the task stuck
       "running" and must not throw into the caller. Mark it failed (best
       effort) and still return the refreshed row. */
    console.error("[run-inline] task failed", task.id, (err as Error).message);
    try {
      await completeTask(task.id, "failed", [], "Failed during execution.");
    } catch (markErr) {
      console.error(
        "[run-inline] could not mark task failed",
        task.id,
        (markErr as Error).message,
      );
    }
  }

  return getTask(task.id, agent.workspaceId);
}
