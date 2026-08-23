/**
 * Changing a chain without describing the whole day again.
 *
 * WHY THIS IS A LIST AND NOT A CANVAS
 *
 * The thing that makes this product different from every workflow builder is
 * that nobody assembles anything: they describe their day and say yes. A canvas
 * would put back exactly the learning curve that keeps other tools unused, and
 * it is where "simple" quietly becomes a builder with better copy.
 *
 * But re-describing an eight-step routine to fix one wrong step is worse than
 * either. So: reorder, remove, replace. Three operations, no new concepts, and
 * each one is a sentence somebody could have said out loud.
 *
 * PURE. Every function returns a NEW routine and validates the result, so an
 * edit that would leave something unrunnable is refused rather than saved and
 * discovered at 8am.
 */
import type { ToolDef } from "@/lib/assistant/tools/types";
import { checkRoutine } from "./heal";
import { referencedSlots } from "./slots";
import type { Routine, RoutineStep } from "./types";

export type EditResult =
  | { ok: true; routine: Routine; summary: string }
  | { ok: false; reason: string };

/** Remove one step, by its position as the person sees it (1-based). */
export function removeStep(routine: Routine, position: number): EditResult {
  const index = position - 1;
  const step = routine.steps[index];
  if (!step) return { ok: false, reason: `there is no step ${position}` };

  const steps = routine.steps.filter((_, i) => i !== index);
  if (steps.length === 0) {
    /* An empty routine is a command that does nothing, which is worse than no
       command at all: it still appears in every list. */
    return { ok: false, reason: "that is the only step left, so removing it would leave a routine that does nothing" };
  }

  const broken = firstBrokenSlot({ ...routine, steps });
  if (broken) {
    /* The failure this prevents: removing step two, and step four silently
       stops working because it read what step two wrote. */
    return {
      ok: false,
      reason: `a later step reads what that one produces (${broken}), so removing it would break the chain`,
    };
  }

  return { ok: true, routine: { ...routine, steps }, summary: `Removed "${label(step)}".` };
}

/** Move one step to another position, both 1-based, as the person counts. */
export function moveStep(routine: Routine, from: number, to: number): EditResult {
  const fromIndex = from - 1;
  const toIndex = to - 1;
  const step = routine.steps[fromIndex];
  if (!step) return { ok: false, reason: `there is no step ${from}` };
  if (toIndex < 0 || toIndex >= routine.steps.length) return { ok: false, reason: `there is no position ${to}` };
  if (fromIndex === toIndex) return { ok: false, reason: "that step is already there" };

  const steps = [...routine.steps];
  steps.splice(fromIndex, 1);
  steps.splice(toIndex, 0, step);

  const broken = firstBrokenSlot({ ...routine, steps });
  if (broken) {
    return {
      ok: false,
      reason: `that would put a step before the one that produces what it reads (${broken})`,
    };
  }

  return { ok: true, routine: { ...routine, steps }, summary: `Moved "${label(step)}" to position ${to}.` };
}

/** Swap the tool a step calls, keeping the label the person wrote. */
export function replaceTool(
  routine: Routine,
  position: number,
  tool: string,
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
  role: string,
): EditResult {
  const index = position - 1;
  const step = routine.steps[index];
  if (!step) return { ok: false, reason: `there is no step ${position}` };
  if (step.kind !== "tool") return { ok: false, reason: `step ${position} does not call a tool` };

  const steps = [...routine.steps];
  /* Parameters are dropped, not carried. They belonged to the old tool's
     schema, and moving them across is a guess dressed as continuity. */
  steps[index] = { ...step, tool, params: {} };

  const health = checkRoutine({ ...routine, steps }, tools, role);
  if (!health.ok) {
    return { ok: false, reason: health.problems.map((p) => p.detail).join(" ") };
  }

  return {
    ok: true,
    routine: { ...routine, steps },
    summary: `Step ${position} now uses ${tool}.`,
  };
}

/**
 * The first slot read before it is written, or null when the order is sound.
 *
 * This is the invariant that makes editing safe to offer at all: a chain whose
 * steps are in the wrong order fails at run time with a message about a missing
 * slot, long after the edit that caused it.
 */
function firstBrokenSlot(routine: Routine): string | null {
  const written = new Set<string>();
  for (const step of routine.steps) {
    const reads =
      step.kind === "tool"
        ? referencedSlots(step.params)
        : step.kind === "model"
          ? referencedSlots(step.prompt)
          : (step.show ?? []);
    for (const slot of reads) {
      if (!written.has(slot)) return slot;
    }
    if (step.kind !== "human" && step.slot) written.add(step.slot);
  }
  return null;
}

function label(step: RoutineStep): string {
  return "label" in step ? step.label : "that step";
}

/** The routine as a numbered list, which is how somebody refers to a step. */
export function describeSteps(routine: Routine): string {
  return routine.steps
    .map((s, i) => {
      const n = i + 1;
      if (s.kind === "human") return `${n}. **${s.label}** (yours)`;
      if (s.kind === "model") return `${n}. **${s.label}** (thinking)`;
      return `${n}. **${s.label}** (${s.tool})`;
    })
    .join("\n");
}
