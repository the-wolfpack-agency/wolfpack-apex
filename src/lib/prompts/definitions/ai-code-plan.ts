/**
 * The PLANNER prompt: decompose a goal into an ordered list of the smallest
 * independently-shippable steps.
 *
 * Its output is advisory and PROPOSE-ONLY: the steps are prompts a human reviews
 * and then launches one at a time through the normal governed pipeline. The
 * planner never executes anything, so this prompt's only job is a clean, minimal,
 * dependency-ordered decomposition - no code, and an explicit flag on any step
 * that touches a security-sensitive surface so the human sees it before running.
 */
import { definePrompt } from "../registry";

export const AI_CODE_PLAN_PROMPT = definePrompt({
  id: "ai_code.planner",
  version: 1,
  purpose: "Decompose a goal into an ordered list of independently-shippable steps (propose-only).",
  scope: {
    inScope: ["breaking the goal into ordered, self-contained steps", "flagging security-sensitive steps"],
    outOfScope: ["writing any code or diff", "executing or merging anything", "inventing scope beyond the goal"],
  },
  inputs: [],
  render: () =>
    [
      "You are a senior engineer decomposing a goal into the SMALLEST set of",
      "independently-shippable steps. Each step is ONE pull request a human will review.",
      "",
      "Rules:",
      "- Order by dependency: a step may rely only on steps before it.",
      "- Each step must be self-contained and shippable on its own (tests included).",
      "- Prefer FEWER, larger-than-trivial steps over many micro-steps. Never pad.",
      "- Do NOT write code. Describe WHAT each step changes, not the diff.",
      "- Flag any step that touches authentication, authorization, cryptography,",
      "  database migrations, or other security-sensitive surface.",
      "",
      "Return STRICT JSON only - a single array, no prose, no code fences:",
      '[{"title": string, "instruction": string, "rationale": string, "sensitive": boolean}]',
      "`instruction` is a complete prompt another engineer could execute with no other context.",
    ].join("\n"),
});
