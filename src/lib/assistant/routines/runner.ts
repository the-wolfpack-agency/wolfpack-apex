/**
 * The routine runner: steps in order, stop at a person, record who spent what.
 *
 * WHAT THIS IS RESPONSIBLE FOR, AND WHAT IT REFUSES TO BE
 *
 * It advances a run: substitute slots, dispatch a step, store the result, move
 * the cursor, and stop when a person is needed or the work is done. It is NOT
 * an agent. It does not decide what to do next, retry a judgement call, or
 * work around a failure. A chain that improvises is one nobody can predict,
 * and unpredictability is disqualifying for something that sends mail on
 * somebody's behalf.
 *
 * PURE CORE, INJECTED EDGES
 *
 * Every side effect arrives through RunnerDeps: dispatching a tool, asking a
 * model, and reading the clock. That is what lets the interesting behaviour
 * (a step fails mid-chain, a person takes eleven minutes, a slot is missing)
 * be tested exactly rather than approximately.
 *
 * THE CLOCK IS A DEPENDENCY BECAUSE TIME IS THE OUTPUT
 *
 * The point of persisting a run is the split between machine time and human
 * time. Those two numbers are what turn "this routine feels slow" into "step
 * four costs eleven minutes a day, and nobody ever changes what it produces".
 * A clock read from inside would make the measurement untestable, and an
 * untested measurement is one that silently drifts into being wrong.
 *
 * FAILURE STOPS THE CHAIN
 *
 * A failed step ends the run. The alternative, carrying on with a slot the
 * failed step should have written, is how a chain reaches its "send this to
 * the client" step holding half of what it needed. Every step completed before
 * the failure is kept and reported: the person needs to know what already
 * happened, not just that something broke.
 */
import type {
  Routine,
  RoutineRun,
  RoutineStep,
  StepOutcome,
  ToolStep,
  ModelStep,
} from "./types";
import { interpolate, MissingSlotError } from "./slots";

/** Everything the runner cannot do for itself. */
export interface RunnerDeps {
  /** Run one registered tool. Returns the dispatch result, or null when the
   *  tool is unknown -- a saved routine outliving a tool is a real case. */
  dispatchTool: (
    tool: string,
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; answer?: string; data?: unknown; error?: string } | null>;
  /** Ask the model. Goes through the router at the call site, so a routine
   *  inherits redaction, residency, the budget and the content policy. */
  askModel: (prompt: string) => Promise<string>;
  /** Milliseconds. Injected so the timing split can be asserted. */
  now: () => number;
}

/** A fresh run, positioned before the first step. */
export function startRun(
  routine: Routine,
  who: { runId: string; userId: string; workspaceId: string },
): RoutineRun {
  return {
    runId: who.runId,
    routineId: routine.id,
    userId: who.userId,
    workspaceId: who.workspaceId,
    state: "running",
    cursor: 0,
    outcomes: [],
    slots: {},
    techMs: 0,
    humanMs: 0,
  };
}

/**
 * Run from the cursor until a person is needed, the routine ends, or a step
 * fails.
 *
 * Returns a NEW run rather than mutating: a run is persisted between calls,
 * and an in-place edit that half-succeeded would leave the stored copy
 * describing a state that never existed.
 */
export async function advance(
  routine: Routine,
  run: RoutineRun,
  deps: RunnerDeps,
): Promise<RoutineRun> {
  /* A finished run is not restartable here. Re-running "send the client an
     update" because a caller asked twice is the kind of accident that has to
     be impossible rather than unlikely. */
  if (run.state === "done" || run.state === "failed") return run;

  let cursor = run.cursor;
  const outcomes = [...run.outcomes];
  const slots = { ...run.slots };
  let techMs = run.techMs;

  while (cursor < routine.steps.length) {
    const step = routine.steps[cursor];

    if (step.kind === "human") {
      /* STOP, and record WHEN, so the wait can be priced when the person comes
         back. The outcome is written now, as "waiting", because a run that
         shows nothing at the step it is sitting on reads as a run that hung. */
      outcomes.push({
        index: cursor,
        kind: "human",
        label: step.label,
        status: "waiting",
        durationMs: 0,
      });
      return {
        ...run,
        state: "waiting_for_human",
        cursor,
        outcomes,
        slots,
        techMs,
        pausedAt: deps.now(),
      };
    }

    const started = deps.now();
    const outcome = await runStep(step, slots, deps);
    outcome.index = cursor;
    outcome.durationMs = Math.max(0, deps.now() - started);
    techMs += outcome.durationMs;
    outcomes.push(outcome);

    if (outcome.status === "failed") {
      return { ...run, state: "failed", cursor, outcomes, slots, techMs };
    }

    cursor += 1;
  }

  return { ...run, state: "done", cursor, outcomes, slots, techMs };
}

/**
 * A person has come back. Bank what their part cost, and carry on.
 *
 * `pausedAt` is passed in rather than read from the run, because a stored run
 * is the only place it survives and the store owns that column. Guarded so a
 * clock skew or a missing timestamp can never subtract time from the total: a
 * negative human cost would quietly flatter every routine it touched.
 */
export async function resume(
  routine: Routine,
  run: RoutineRun,
  deps: RunnerDeps,
  pausedAt?: number | null,
): Promise<RoutineRun> {
  if (run.state !== "waiting_for_human") return run;

  const from = pausedAt ?? run.pausedAt ?? null;
  const waited = from ? Math.max(0, deps.now() - from) : 0;
  const outcomes = [...run.outcomes];
  const last = outcomes[outcomes.length - 1];
  if (last && last.status === "waiting") {
    /* The human step's own duration IS the wait. Keeping it on the step rather
       than only in a total is what lets "which step do people stall on" be a
       query instead of an investigation. */
    outcomes[outcomes.length - 1] = { ...last, status: "ok", durationMs: waited };
  }

  return advance(
    routine,
    {
      ...run,
      state: "running",
      cursor: run.cursor + 1,
      outcomes,
      humanMs: run.humanMs + waited,
      pausedAt: null,
    },
    deps,
  );
}

/** One tool or model step, with its slot references resolved. */
async function runStep(
  step: ToolStep | ModelStep,
  slots: Record<string, unknown>,
  deps: RunnerDeps,
): Promise<StepOutcome> {
  const base: StepOutcome = {
    index: 0,
    kind: step.kind,
    label: step.label,
    status: "ok",
    durationMs: 0,
    ...(step.slot ? { slot: step.slot } : {}),
  };

  try {
    if (step.kind === "model") {
      const prompt = interpolate(step.prompt, slots);
      const answer = await deps.askModel(prompt);
      if (step.slot) slots[step.slot] = answer;
      return { ...base, answer };
    }

    const params = interpolate(step.params, slots);
    const res = await deps.dispatchTool(step.tool, params);
    if (!res) {
      /* A routine saved against a tool that no longer exists. Named plainly,
         because the fix is editing the routine and the person needs to know
         which step to edit. */
      return {
        ...base,
        status: "failed",
        error: `This step uses "${step.tool}", which is not a tool any more. The routine needs editing.`,
      };
    }
    if (!res.ok) {
      return { ...base, status: "failed", error: res.error ?? "The step did not complete." };
    }
    if (step.slot) slots[step.slot] = res.data ?? res.answer ?? null;
    return { ...base, ...(res.answer ? { answer: res.answer } : {}) };
  } catch (err) {
    /* A missing slot is the one failure worth its own sentence: it means the
       ROUTINE is wrong rather than the tool, and the message says so. */
    if (err instanceof MissingSlotError) {
      return { ...base, status: "failed", error: err.message };
    }
    /* Anything else is reported, never thrown. A chain that throws loses every
       step that already succeeded, including the ones that wrote something. */
    return {
      ...base,
      status: "failed",
      error: err instanceof Error ? err.message : "The step did not complete.",
    };
  }
}

/** Steps that never ran, because the chain stopped before reaching them. */
export function remainingSteps(routine: Routine, run: RoutineRun): RoutineStep[] {
  return routine.steps.slice(run.cursor + (run.state === "done" ? 0 : 1));
}
