/**
 * Keeping a chain working, and knowing when it is not.
 *
 * A routine is a promise somebody made once and relies on every morning. The
 * things it depends on move underneath it: a tool gets renamed, a parameter
 * shape changes, somebody's role changes, a connector is disconnected. Left
 * alone, the first anybody hears is a failed run at 8am on a day they were
 * counting on it.
 *
 * Two halves, and the first matters more.
 *
 * CHECKING, which is deterministic and free. Every step of a saved routine is
 * re-resolved against the live registry: does the tool exist, does this person
 * still have the capability, do the stored parameters still satisfy the tool's
 * own schema. That is not a guess, it is the same validation the dispatcher
 * runs, done early. Most breakage is found here, before anybody is waiting.
 *
 * REPAIRING, which is where a model earns its place. "This tool is gone, what
 * should replace it" is a judgement about meaning, and rules cannot make it.
 * So a model proposes, and the registry decides: a replacement that does not
 * exist, or that this person cannot invoke, is discarded rather than written
 * into somebody's morning.
 *
 * NOTHING IS REPAIRED SILENTLY. A proposal goes to the owner and waits. A chain
 * that rewrites itself is a chain nobody can reason about, and the whole reason
 * routines are trusted with a mailbox is that they do only what they say.
 */
import type { ToolDef } from "@/lib/assistant/tools/types";
import { canInvokeTool } from "@/lib/assistant/tools/gate";
import type { Routine, RoutineStep, ToolStep } from "./types";

export type ProblemKind =
  /** The tool named by this step is not registered any more. */
  | "tool_missing"
  /** The tool exists but this person's role cannot invoke it. */
  | "not_permitted"
  /** The stored parameters no longer satisfy the tool's schema. */
  | "params_invalid";

export interface StepProblem {
  stepIndex: number;
  label: string;
  kind: ProblemKind;
  /** The tool the step names, for a message somebody can act on. */
  tool: string;
  /** Plain wording, for the person rather than for a log. */
  detail: string;
}

export interface RoutineHealth {
  ok: boolean;
  problems: StepProblem[];
}

/**
 * Does this routine still do what it says?
 *
 * Pure and cheap, so it can run before every scheduled execution rather than
 * only after something has already gone wrong.
 */
export function checkRoutine(
  routine: Routine,
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
  role: string,
): RoutineHealth {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const problems: StepProblem[] = [];

  routine.steps.forEach((step, stepIndex) => {
    if (step.kind !== "tool") return;
    const tool = byName.get(step.tool);

    if (!tool) {
      problems.push({
        stepIndex,
        label: step.label,
        kind: "tool_missing",
        tool: step.tool,
        detail: `"${step.tool}" is not something I can run any more.`,
      });
      return;
    }

    if (!canInvokeTool(role, tool.capability)) {
      problems.push({
        stepIndex,
        label: step.label,
        kind: "not_permitted",
        tool: step.tool,
        detail: `Your role can no longer run "${step.tool}".`,
      });
      return;
    }

    /* The tool's OWN schema, not a copy of it. A second description of what a
       tool accepts is a second thing to keep in step, and it would disagree
       exactly when it mattered. Steps carrying slot references are skipped:
       "{{inbox}}" is a placeholder, and validating it before the slot exists
       would report a problem that only exists on paper. */
    if (!hasSlotReference(step.params)) {
      const parsed = tool.paramSchema.safeParse(step.params);
      if (!parsed.success) {
        problems.push({
          stepIndex,
          label: step.label,
          kind: "params_invalid",
          tool: step.tool,
          detail: `"${step.tool}" no longer accepts what this step passes it.`,
        });
      }
    }
  });

  return { ok: problems.length === 0, problems };
}

/** Whether a parameter object defers to an earlier step's output. */
function hasSlotReference(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes("{{");
}

export interface Repair {
  stepIndex: number;
  /** What to do about it. "drop" is a real answer and often the right one. */
  action: "replace_tool" | "drop_step";
  /** For replace_tool, a tool that exists and the person may invoke. */
  tool?: string;
  /** Why, in the person's terms. Shown when they are asked to approve. */
  reason: string;
}

/**
 * What we ask the model, and the only thing we ask it.
 *
 * Constrained to picking a replacement from a supplied list or saying there is
 * none. Everything it returns is checked afterwards, so the prompt's job is to
 * make verification pass often rather than to be trusted.
 */
export function buildRepairPrompt(
  problem: StepProblem,
  step: ToolStep,
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
): string {
  const manifest = tools.map((t) => `${t.name}: ${t.description.split(/(?<=\.)\s/)[0]}`).join("\n");
  return [
    "A saved workflow has a broken step. Pick the best replacement from the list, or say there is none.",
    "",
    `The step is described as: "${step.label}"`,
    `It used to call: ${problem.tool}`,
    `The problem: ${problem.detail}`,
    "",
    "Rules:",
    "- Reply with a tool name EXACTLY as written below, or with null. Never invent a name.",
    "- Only choose a tool that does the SAME job. A tool that does something adjacent is worse than none, because the person trusts this workflow to do what it says.",
    "- If nothing does that job any more, reply with null and the step will be removed.",
    "",
    'Reply with JSON only: {"tool":"tool_name_or_null","reason":"one short sentence"}',
    "",
    "Tools:",
    manifest,
  ].join("\n");
}

/**
 * Read the model's suggestion and check it against reality.
 *
 * A replacement that does not exist, that the person cannot invoke, or that is
 * the very tool already known to be broken, is discarded. What comes back is
 * either a repair that will work or an honest "remove the step".
 */
export function readRepair(
  raw: string,
  problem: StepProblem,
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
  role: string,
): Repair {
  const drop: Repair = {
    stepIndex: problem.stepIndex,
    action: "drop_step",
    reason: `Nothing else does what "${problem.tool}" did, so this step would be removed.`,
  };

  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return drop;

  let parsed: { tool?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { tool?: unknown; reason?: unknown };
  } catch {
    return drop;
  }

  const name = typeof parsed.tool === "string" && parsed.tool !== "null" ? parsed.tool : null;
  if (!name) return drop;
  /* Suggesting the broken tool as its own replacement is a model agreeing with
     the question rather than answering it. */
  if (name === problem.tool) return drop;

  const tool = tools.find((t) => t.name === name);
  if (!tool) return drop;
  if (!canInvokeTool(role, tool.capability)) return drop;
  /* AND IT HAS TO RUN WITH NOTHING.
     A repaired step carries no parameters, because the old ones belonged to a
     different schema. So a replacement that requires a detail before it can do
     anything would fail on its first run, and the failure would now look like
     our fix rather than the original breakage. Removing the step is the honest
     outcome. */
  if (!tool.paramSchema.safeParse({}).success) return drop;

  return {
    stepIndex: problem.stepIndex,
    action: "replace_tool",
    tool: name,
    reason:
      typeof parsed.reason === "string" && parsed.reason.length > 3
        ? parsed.reason.slice(0, 200)
        : `${name} does the same job.`,
  };
}

/**
 * Apply repairs to a copy of the routine.
 *
 * A copy, always. The stored routine changes only when the owner has agreed,
 * and holding the repaired version separately is what makes "here is what it
 * would become" possible to show them.
 *
 * A replaced tool keeps the step's LABEL and loses its parameters. The label is
 * what the person wrote about their own work and is still true; the parameters
 * belonged to a different tool's schema and carrying them across would be a
 * guess dressed as continuity.
 */
export function applyRepairs(routine: Routine, repairs: Repair[]): Routine {
  const dropped = new Set(repairs.filter((r) => r.action === "drop_step").map((r) => r.stepIndex));
  const replaced = new Map(
    repairs.filter((r) => r.action === "replace_tool" && r.tool).map((r) => [r.stepIndex, r.tool!]),
  );

  const steps: RoutineStep[] = [];
  routine.steps.forEach((step, i) => {
    if (dropped.has(i)) return;
    const tool = replaced.get(i);
    if (tool && step.kind === "tool") {
      steps.push({ ...step, tool, params: {} });
      return;
    }
    steps.push(step);
  });

  return { ...routine, steps };
}

/** How to describe a repair to the person being asked to approve it. */
export function describeRepairs(routine: Routine, repairs: Repair[]): string {
  if (repairs.length === 0) return "";
  const lines = [`**${routine.command}** has stopped working, and here is what I would change:`, ""];
  for (const r of repairs) {
    const step = routine.steps[r.stepIndex];
    const label = step && "label" in step ? step.label : `step ${r.stepIndex + 1}`;
    lines.push(
      r.action === "replace_tool"
        ? `- **${label}**: use ${r.tool} instead. ${r.reason}`
        : `- **${label}**: remove this step. ${r.reason}`,
    );
  }
  lines.push("");
  /* The consequence stated plainly, because "yes" here changes something they
     rely on and a shorter chain is a real loss rather than a tidy-up. */
  const remaining = applyRepairs(routine, repairs).steps.length;
  lines.push(
    `That would leave ${remaining} ${remaining === 1 ? "step" : "steps"}. Say yes to apply it, or leave it and the routine stays as it is.`,
  );
  return lines.join("\n");
}
