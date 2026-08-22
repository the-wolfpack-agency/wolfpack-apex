/**
 * Running a routine from the chat surface.
 *
 * THE ONE PLACE THE PIECES MEET: the catalogue says what the steps are, the
 * runner advances them, the store records where the time went, and this file
 * supplies the two things neither of those may have -- a way to reach a tool,
 * and a way to reach a model.
 *
 * Both are borrowed rather than built. Tools go through dispatchToolByName,
 * which is the chat path minus the intent guessing, so every capability check,
 * OGIAM decision, confirmation and ledger write still happens. The model goes
 * through the same router every other feature uses, so a routine inherits
 * redaction, residency, the budget and the content policy. There is no cheaper
 * path to either from in here, which is the point: a chain is a faster way
 * through the existing gates, never a way around them.
 */
import { getAIClient } from "@/lib/ai/router";
import { dispatchToolByName } from "@/lib/assistant/tools/dispatcher";
import type { ToolContext } from "@/lib/assistant/tools/types";
import { advance, resume, startRun, type RunnerDeps } from "./runner";
import { saveRun, trackRun } from "./store";
import { matchRoutine, routineById } from "./catalogue";
import type { Routine, RoutineRun } from "./types";

export { matchRoutine, routineById, BUILT_IN_ROUTINES } from "./catalogue";
export type { Routine, RoutineRun, RoutineStep, StepOutcome } from "./types";

/** Live dependencies: the governed tool path, the governed model path, the clock. */
export function liveDeps(ctx: ToolContext): RunnerDeps {
  return {
    dispatchTool: async (tool, params) => {
      const res = await dispatchToolByName(tool, params, ctx);
      if (!res) return null;
      return res.result.ok
        ? { ok: true, answer: res.result.answer, data: res.result.data }
        : { ok: false, error: res.result.message };
    },
    askModel: async (prompt) => {
      const res = await getAIClient().complete({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 700,
        /* Cheap by default. A step summarising what four tools just returned is
           not a reasoning problem, and paying premium prices for every step of
           every routine is how a feature that saves people time becomes a line
           item somebody cancels. */
        model_tier: "cheap",
        metadata: {
          feature: "assistant.routine",
          user_id: ctx.userId,
          user_role: ctx.userRole,
          ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
        },
      });
      return res.content;
    },
    now: () => Date.now(),
  };
}

/** Begin a routine and run it until it needs a person or finishes. */
export async function runRoutine(
  routine: Routine,
  ctx: ToolContext,
  runId: string,
  deps: RunnerDeps = liveDeps(ctx),
): Promise<RoutineRun> {
  const run = await advance(
    routine,
    startRun(routine, {
      runId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId ?? "default",
    }),
    deps,
  );
  await saveRun(run);
  trackRun(run, ctx.userRole);
  return run;
}

/** A person has come back to a paused run. */
export async function resumeRoutine(
  routine: Routine,
  run: RoutineRun,
  ctx: ToolContext,
  deps: RunnerDeps = liveDeps(ctx),
  opts: { skipped?: boolean } = {},
): Promise<RoutineRun> {
  const next = await resume(routine, run, deps, opts);
  await saveRun(next);
  trackRun(next, ctx.userRole);
  return next;
}

/**
 * What the person reads when a routine stops or finishes.
 *
 * Written as an account of what happened rather than a status dump, because
 * the person is either about to act on it or about to decide the routine is
 * not worth running. A wall of step names does neither.
 */
export function describeRun(routine: Routine, run: RoutineRun): string {
  const done = run.outcomes.filter((o) => o.status === "ok" && o.kind !== "human");
  const lines: string[] = [];

  /* The model's answer is the thing they actually want; it goes first, and the
     bookkeeping goes underneath it. */
  const last = [...run.outcomes].reverse().find((o) => o.answer);
  if (last?.answer) lines.push(last.answer, "");

  if (run.state === "waiting_for_human") {
    const step = routine.steps[run.cursor];
    lines.push(`**${step.kind === "human" ? step.label : "Over to you"}**`);
    /* THE REASON, when the step has one. Somebody told to rehearse at 4pm with
       no reason attached skips it, and the skip then reads as "that step was
       pointless" rather than "nobody said why". */
    if (step.kind === "human" && step.why) lines.push(step.why);
    lines.push(
      step.kind === "human" && step.action === "do"
        ? `${done.length} of ${routine.steps.length} steps done. Tell me when it is done, or say skip. Either answer is fine and both are recorded.`
        : `${done.length} of ${routine.steps.length} steps done. Reply to carry on, or leave it here.`,
    );
    return lines.join("\n");
  }

  if (run.state === "failed") {
    const failed = run.outcomes.find((o) => o.status === "failed");
    lines.push(`This stopped at "${failed?.label ?? "a step"}": ${failed?.error ?? "it did not complete"}.`);
    /* What DID happen still matters: some of it may have written something. */
    if (done.length > 0) lines.push(`${done.length} earlier ${done.length === 1 ? "step" : "steps"} completed.`);
    return lines.join("\n");
  }

  lines.push(`Done. ${done.length} ${done.length === 1 ? "step" : "steps"}, ${Math.round(run.techMs / 100) / 10}s of work.`);
  return lines.join("\n");
}
