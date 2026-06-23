/**
 * Deterministic task planner. Splits a goal into ordered sub-goal instructions
 * by line, stripping list markers, so a human can assign a multi-step task as a
 * numbered or bulleted list and the executor runs each step under the gate. No
 * LLM, so it is fully deterministic and testable; an LLM planner is a drop-in
 * replacement behind the AgentPlanner interface when richer planning is wanted.
 */

import type { AgentPlanner } from "./types";

/** Max steps a single task may expand to (a runaway-plan backstop). */
export const MAX_TASK_STEPS = 10;

export class IntentPlanner implements AgentPlanner {
  readonly kind = "intent";

  plan(goal: string): string[] {
    const lines = (goal ?? "")
      .split(/\r?\n/)
      .map((l) => stripMarker(l).trim())
      .filter((l) => l.length > 0);

    // No line breaks: treat the whole goal as a single step.
    const steps = lines.length > 0 ? lines : [(goal ?? "").trim()].filter(Boolean);
    return steps.slice(0, MAX_TASK_STEPS);
  }
}

/** Remove a leading list marker like "1.", "1)", "-", "*", or a bullet. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "");
}

export function getPlanner(): AgentPlanner {
  return new IntentPlanner();
}
