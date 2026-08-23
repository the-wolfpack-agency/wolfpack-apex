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
import { referencedSlots } from "./slots";
import { saveRun, trackRun } from "./store";
import { matchRoutine, routineById, BUILT_IN_ROUTINES as BUILT_IN } from "./catalogue";
import type { Routine, RoutineRun } from "./types";

export { matchRoutine, routineById, BUILT_IN_ROUTINES } from "./catalogue";

/**
 * Words that mean "I have done my part, carry on".
 *
 * DELIBERATELY A SHORT, EXACT LIST. The alternative, treating any message as
 * the answer while a run is waiting, would swallow every unrelated question
 * somebody asked in the meantime: they ask about the weather and instead their
 * chain moves on. A named word is unambiguous, and the pause tells them which
 * words work rather than leaving them to guess.
 */
const CARRY_ON = ["done", "carry on", "continue", "next", "go on", "finished", "ok done"];
const SKIP_IT = ["skip", "skip it", "not this time", "did not do it", "didn't do it"];

export type ResumeIntent = "carry_on" | "skip" | "none";

/** What this message says about a routine that is waiting on somebody. */
export function detectResumeIntent(message: string): ResumeIntent {
  let text = message.trim().toLowerCase();
  let end = text.length;
  while (end > 0 && ".!?,".includes(text[end - 1])) end -= 1;
  text = text.slice(0, end).trim();
  if (CARRY_ON.includes(text)) return "carry_on";
  if (SKIP_IT.includes(text)) return "skip";
  return "none";
}
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
    /* A QUESTION, not a checkpoint. The pause reads completely differently:
       somebody is being asked to type an answer, not to go and do something,
       and telling them to say "done" would be nonsense. */
    if (run.pendingAsk) {
      lines.push(`**${run.pendingAsk.question}**`);
      lines.push("");
      lines.push(
        `${done.length} of ${routine.steps.length} steps done. Tell me and I will carry on.`,
      );
      return lines.join("\n");
    }

    const step = routine.steps[run.cursor];
    lines.push(`**${step.kind === "human" ? step.label : "Over to you"}**`);
    /* THE REASON, when the step has one. Somebody told to rehearse at 4pm with
       no reason attached skips it, and the skip then reads as "that step was
       pointless" rather than "nobody said why". */
    if (step.kind === "human" && step.why) lines.push(step.why);
    /* NAME THE WORDS. "Reply to carry on" was a promise nothing listened for,
       and a person who replies and gets nothing learns the chain is broken.
       Saying which words work makes the promise keepable and checkable. */
    lines.push(
      step.kind === "human" && step.action === "do"
        ? `${done.length} of ${routine.steps.length} steps done. Say **done** when you have, or **skip** if you are not going to. Either is fine and both are recorded.`
        : `${done.length} of ${routine.steps.length} steps done. Say **done** to carry on, or leave it here.`,
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

/**
 * Pick up a routine that was waiting on somebody.
 *
 * WHAT A RESUMED RUN DOES NOT HAVE is the slot values from before. They are
 * deliberately never stored (migration 232: they carry mail bodies and draft
 * replies, and a table of those is a second copy of the mailbox without its
 * controls). So a later step that reads an earlier step's output cannot run,
 * and the honest thing is to say which step and why rather than to fail with a
 * message about a missing slot.
 *
 * Every routine that ships today is fine, because their human steps come after
 * everything that reads a slot. This exists so the first one that is not fine
 * explains itself instead of breaking.
 */
export async function resumeWaitingRoutine(
  ctx: ToolContext,
  intent: "carry_on" | "skip" | "answer",
  deps?: RunnerDeps,
  answer?: string,
): Promise<{ answer: string } | null> {
  const owner = { workspaceId: ctx.workspaceId || "default", userId: ctx.userId };
  const { loadWaitingRun } = await import("./store");
  const waiting = await loadWaitingRun(owner);
  if (!waiting) return null;

  const routine =
    matchRoutineById(waiting.routineId) ?? (await matchSavedRoutineById(owner, waiting.routineId));
  if (!routine) {
    return {
      answer:
        "That routine does not exist any more, so there is nothing to carry on with. Nothing was lost: the steps that already ran are recorded.",
    };
  }

  /* Can what is LEFT actually run without the slots we no longer hold?
     A run waiting on a QUESTION is different: the step that asked has not run
     yet, so the remaining work starts at that step rather than after it. */
  const remaining = routine.steps.slice(waiting.cursor + (waiting.pendingAsk ? 0 : 1));
  /* A SLOT IS ONLY MISSING IF NOTHING LEFT TO RUN WILL WRITE IT.
   *
   * This asked whether any remaining step reads a slot at all, which is a
   * different and much harsher question. In a chain that pauses to ASK, the
   * steps that fill those slots have not run yet: they are the next thing to
   * happen. Answering the question and being told the chain cannot continue,
   * because a later step reads something the steps about to run will produce,
   * made every asking routine impossible to finish.
   *
   * Found by running one against production. The reads-anything check was
   * right for a chain paused AFTER its gathering, and wrong for one paused
   * BEFORE it, and only the second kind exists now.
   *
   * Walked in order, tracking what each step writes, which is the same order
   * invariant the editor enforces. */
  const willWrite = new Set<string>();
  const needsSlot = remaining.find((step) => {
    const reads =
      step.kind === "tool"
        ? referencedSlots(step.params)
        : step.kind === "model"
          ? referencedSlots(step.prompt)
          : [];
    const missing = reads.some((slot) => !willWrite.has(slot));
    if (step.kind !== "human" && step.slot) willWrite.add(step.slot);
    return missing;
  });
  if (needsSlot) {
    return {
      answer: [
        `Recorded. I cannot finish **${routine.command}** from here, though: "${"label" in needsSlot ? needsSlot.label : "a later step"}" reads what an earlier step produced, and I do not keep that between sessions on purpose.`,
        "",
        `Run **${routine.command}** again and it will go straight through.`,
      ].join("\n"),
    };
  }

  const run = await resumeRoutine(routine, waiting, ctx, deps ?? liveDeps(ctx), {
    skipped: intent === "skip",
    ...(intent === "answer" ? { answer } : {}),
  });
  return { answer: describeRun(routine, run) };
}

/** Built-in lookup by id, for a run that only recorded the id. */
function matchRoutineById(id: string): Routine | null {
  return BUILT_IN.find((r) => r.id === id) ?? null;
}

/** A saved routine by id: they are stored under a generated id. */
async function matchSavedRoutineById(
  owner: { workspaceId: string; userId: string },
  id: string,
): Promise<Routine | null> {
  const { listSavedRoutines } = await import("./saved");
  const saved = await listSavedRoutines(owner);
  return saved.find((r) => r.id === id) ?? null;
}

/** Is a waiting run waiting for a VALUE rather than for somebody to act? */
export async function pendingQuestion(ctx: ToolContext): Promise<string | null> {
  const { loadWaitingRun } = await import("./store");
  const waiting = await loadWaitingRun({
    workspaceId: ctx.workspaceId || "default",
    userId: ctx.userId,
  });
  return waiting?.pendingAsk?.question ?? null;
}
