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
import {
  groundFromBrain,
  type Grounding,
} from "@/lib/agents/grounding/brain-grounding";
import {
  selectModel,
  logModelSelection,
  type ModelSelection,
} from "@/lib/ai/models";
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
type GroundFn = typeof groundFromBrain;
type SelectModelFn = typeof selectModel;
type LogModelSelectionFn = typeof logModelSelection;

export interface ExecutorDeps {
  dispatch?: DispatchFn;
  notifyOwner?: NotifyFn;
  /** Inheritance: find a promoted procedure for this goal. */
  lookupProcedure?: LookupFn;
  /** Learning: record the plan a succeeded task ran. */
  recordProcedure?: RecordFn;
  /**
   * Brain grounding: consult org knowledge before an EXPLORING run spends
   * tokens. Best-effort and only invoked when the run is NOT inherited
   * (deterministic-first: a reused procedure never triggers Brain spend).
   */
  ground?: GroundFn;
  /**
   * Cost-aware model selection: which best-priced capable model an exploring
   * run would use. Pure + deterministic; invoked only when NOT inherited.
   */
  selectModel?: SelectModelFn;
  /** Records the model decision to analytics so no routing decision is lost. */
  logModelSelection?: LogModelSelectionFn;
  /**
   * Optional model pin for this agent. Threaded into the router so an agent can
   * insist on a specific model; absent means pure cost-based selection.
   */
  agentPin?: string;
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
  const ground = deps.ground ?? groundFromBrain;
  const chooseModel = deps.selectModel ?? selectModel;
  const recordModelChoice = deps.logModelSelection ?? logModelSelection;

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
  let errored = false;

  // Maturation telemetry. An agent that deploys into a new system should get
  // MORE deterministic and CHEAPER over time: it reuses learned procedures (no
  // token consideration at all) and, only when it must explore, it grounds in
  // the Brain and picks the best-priced capable model. We record both so the
  // "familiarity / deterministic-vs-AI" curve is measurable run over run.
  let grounding: Grounding = { used: false, hits: 0, snippets: [] };
  let modelSelection: ModelSelection | undefined;

  const agentCtx: {
    userId: string;
    userRole: string;
    workspaceId: string;
    agentPrincipal: {
      agentId: string;
      role: string;
      workspaceId: string;
      ownerUserId: string;
    };
    grounding?: { snippets: string[] };
  } = {
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

  // DETERMINISTIC-FIRST. Only an EXPLORING run (no inherited procedure) ever
  // considers tokens. A reused procedure is free: we deliberately do NOT ground
  // against the Brain and do NOT consult the cost-aware router, so reuse never
  // triggers any token spend or model decision. This is the cost plateau made
  // concrete.
  if (!inherited) {
    // Best-effort grounding. A Brain/embedder hiccup never throws here
    // (groundFromBrain swallows failures) and never blocks the task: on any
    // failure we keep the empty grounding and run ungrounded.
    try {
      grounding = await ground(task.goal, task.workspaceId, {
        userId: task.agentId,
        userRole: task.role,
      });
    } catch {
      /* grounding is a best-effort speedup; the task still runs ungrounded */
    }
    if (grounding.snippets.length > 0) {
      // Hand org knowledge to AI-backed tools so they spend fewer tokens.
      // Deterministic tools ignore this field.
      agentCtx.grounding = { snippets: grounding.snippets };
    }

    // Cost-aware model selection. selectModel is pure + never throws, but we
    // still guard the whole block so a router/analytics hiccup can never break
    // or slow the task beyond this best-effort call.
    try {
      modelSelection = chooseModel({
        requiredTier: "large",
        agentPin: deps.agentPin,
      });
      recordModelChoice(modelSelection, {
        userId: task.agentId,
        userRole: task.role,
        extra: { task_id: task.id, brain_grounded: grounding.used },
      });
    } catch {
      /* model routing is best effort; the task runs regardless */
    }
  }

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
      // A successful result that only surfaces a FORM did no real work: a form
      // exists to collect human input, and an agent cannot fill or submit one.
      // Treat it as a needs-human failure, never a silent "ran" (the bug where
      // "add a task" returned a form to nobody and the task was never created).
      if ((r as { form?: unknown }).form) {
        steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: "this step needs a human to complete a form; an agent cannot submit it" });
        errored = true;
        break;
      }
      steps.push({ index: i, instruction, tool: res.tool, outcome: "ran", detail: truncate((r as { answer: string }).answer) });
    } else {
      // A tool-level failure (not a gate block) is a real error: record it and
      // stop acting. A task whose step errored has NOT succeeded.
      steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate((r as { message: string }).message) });
      errored = true;
      break;
    }
  }

  const ran = steps.filter((s) => s.outcome === "ran").length;
  // Honest terminal status. Blocked (a governance escalation) takes precedence.
  // A real tool error fails the task, and a task where NOTHING ran never counts
  // as success (the bug that showed "Succeeded / Completed 0 of 1 step"). A
  // partial run where at least one step ran and none errored is a success with
  // the honest step count in the summary.
  if (status !== "failed") {
    if (blocked) status = "blocked";
    else if (errored) status = "failed";
    else if (ran === 0) status = "failed";
    else status = "succeeded";
  }

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

  const resultSummary = blocked
    ? `Stopped for approval after ${ran} step(s).`
    : status === "failed"
      ? ran === steps.length && steps.length > 0
        ? "Failed during execution."
        : `Failed: completed ${ran} of ${steps.length} step(s).`
      : `Completed ${ran} of ${steps.length} step(s).`;

  const brainGrounded = grounding.snippets.length > 0;
  const modelId = modelSelection?.model.id;
  const estCostUsd = modelSelection?.estimatedCostUsd;

  // Maturation telemetry on the existing completion event: `inherited`,
  // `brain_grounded`, and `model_id` make the deterministic-vs-AI / familiarity
  // curve queryable over time without a new join. Inherited (deterministic)
  // runs carry brain_grounded:false and no model_id by construction.
  trackEvent("agent.task_completed", task.agentId, task.role, {
    agent_id: task.agentId,
    task_id: task.id,
    status,
    step_count: steps.length,
    ran_count: ran,
    blocked,
    inherited,
    brain_grounded: brainGrounded,
    ...(modelId ? { model_id: modelId } : {}),
  });

  // Dedicated grounding/maturation event so the familiarity curve has its own
  // namespace independent of task outcome. Best-effort: never breaks the task.
  try {
    trackEvent("agent.execution_grounded", task.agentId, task.role, {
      agent_id: task.agentId,
      task_id: task.id,
      inherited,
      brain_hits: grounding.hits,
      brain_grounded: brainGrounded,
      ...(modelId ? { model_id: modelId } : {}),
      ...(typeof estCostUsd === "number" ? { est_cost_usd: estCostUsd } : {}),
    });
  } catch {
    /* telemetry is best effort; the task already ran */
  }

  return { status, steps, resultSummary, inherited };
}

/**
 * Familiarity score for a sequence of runs: the fraction (0..1) that reused a
 * deterministic learned procedure instead of exploring. As an agent matures in
 * a system this trends toward 1 (more deterministic, cheaper). A future surface
 * can chart it directly. Empty history scores 0 (no familiarity yet). Pure.
 */
export function familiarityScore(history: { inherited: boolean }[]): number {
  if (!history || history.length === 0) return 0;
  const reused = history.filter((h) => h.inherited).length;
  return reused / history.length;
}
