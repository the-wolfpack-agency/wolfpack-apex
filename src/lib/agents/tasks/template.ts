/**
 * Agent task TEMPLATE: the single definition of the structured fields a human
 * fills in to run an agent. Reused by every control-plane surface so the form,
 * the assistant widget, and the API validate and compose identically (DRY).
 *
 * Mapping to the task model:
 *   - `objective`        -> the task `goal` (the planner splits it into steps).
 *   - `successCriteria`  -> stored column + run-context guidance (definition of done).
 *   - `context`          -> stored column + run-context guidance.
 *   - `targetConnectionId` -> stored column + run-context guidance.
 *
 * Objective and Success criteria are required; Context and Target are optional.
 * Guidance is attached to the agent run context (never appended to the goal) so
 * it informs execution WITHOUT creating spurious plan steps.
 */

/** Where a task submission originated. Feeds the learning loop. */
export type TaskSource = "detail_page" | "chat_widget" | "api";

export interface TaskTemplateInput {
  objective: string;
  successCriteria: string;
  context?: string;
  targetConnectionId?: string;
}

export const TEMPLATE_LIMITS = {
  objective: 4000,
  successCriteria: 2000,
  context: 4000,
  targetConnectionId: 200,
} as const;

export interface TaskTemplateFieldSpec {
  key: keyof TaskTemplateInput;
  label: string;
  required: boolean;
  kind: "textarea" | "connection";
  placeholder: string;
  maxLen: number;
  help?: string;
}

/** The field specs the UI renders. One source for the page form + the widget. */
export const TASK_TEMPLATE_FIELDS: TaskTemplateFieldSpec[] = [
  {
    key: "objective",
    label: "Objective",
    required: true,
    kind: "textarea",
    placeholder: "What should this agent accomplish? Number the steps if there are several.",
    maxLen: TEMPLATE_LIMITS.objective,
    help: "The work itself. This becomes the agent's plan.",
  },
  {
    key: "successCriteria",
    label: "Success criteria",
    required: true,
    kind: "textarea",
    placeholder: "How will we know it is done and done well?",
    maxLen: TEMPLATE_LIMITS.successCriteria,
    help: "The definition of done. Guides the agent and lets us verify the outcome.",
  },
  {
    key: "context",
    label: "Context",
    required: false,
    kind: "textarea",
    placeholder: "Links, data, background the agent should use (optional).",
    maxLen: TEMPLATE_LIMITS.context,
  },
  {
    key: "targetConnectionId",
    label: "Target system",
    required: false,
    kind: "connection",
    placeholder: "(optional)",
    maxLen: TEMPLATE_LIMITS.targetConnectionId,
    help: "A connected system this task should act on.",
  },
];

export type TemplateValidation =
  | { ok: true; value: TaskTemplateInput }
  | { ok: false; error: string };

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Validate a raw template submission. Objective + Success criteria are required;
 * Context + Target optional. Enforces per-field length caps. Returns a typed
 * value on success or a single human-readable error string.
 */
export function validateTaskTemplate(raw: unknown): TemplateValidation {
  const obj = (raw ?? {}) as Record<string, unknown>;

  const objective = asTrimmedString(obj.objective);
  const successCriteria = asTrimmedString(obj.successCriteria);
  const context = asTrimmedString(obj.context);
  const targetConnectionId = asTrimmedString(obj.targetConnectionId);

  if (!objective) return { ok: false, error: "Objective is required." };
  if (objective.length > TEMPLATE_LIMITS.objective)
    return { ok: false, error: `Objective must be <= ${TEMPLATE_LIMITS.objective} characters.` };

  if (!successCriteria) return { ok: false, error: "Success criteria is required." };
  if (successCriteria.length > TEMPLATE_LIMITS.successCriteria)
    return { ok: false, error: `Success criteria must be <= ${TEMPLATE_LIMITS.successCriteria} characters.` };

  if (context.length > TEMPLATE_LIMITS.context)
    return { ok: false, error: `Context must be <= ${TEMPLATE_LIMITS.context} characters.` };
  if (targetConnectionId.length > TEMPLATE_LIMITS.targetConnectionId)
    return { ok: false, error: "Target system reference is too long." };

  return {
    ok: true,
    value: {
      objective,
      successCriteria,
      context: context || undefined,
      targetConnectionId: targetConnectionId || undefined,
    },
  };
}

/**
 * Compose the run-context guidance from the optional/verification fields. This
 * is attached to the agent run context (agentCtx.guidance), NOT appended to the
 * goal, so it never creates extra plan steps. Returns undefined when there is
 * nothing beyond the objective.
 */
export function composeGuidance(input: TaskTemplateInput): string | undefined {
  const parts: string[] = [];
  parts.push(`Success criteria (the definition of done): ${input.successCriteria}`);
  if (input.context) parts.push(`Context: ${input.context}`);
  if (input.targetConnectionId) parts.push(`Target system: ${input.targetConnectionId}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
