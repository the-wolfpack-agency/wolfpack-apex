/**
 * Which capability tier a task actually needs.
 *
 * WHAT PRODUCTION SHOWED
 *
 * With both Azure models configured, the router page reported "0% served by the
 * cheapest tier" and every decision going to azure-gpt-4o. The router was not
 * at fault. Its only production caller asked for `requiredTier: "large"`
 * unconditionally, so the cheap model could never be chosen however cheap it
 * was — and gpt-4o is roughly thirty times the input price of gpt-4o-mini.
 *
 * A cost-aware router whose caller hardcodes the expensive tier is a cost-aware
 * router in name only.
 *
 * THE SAME PAGE SHOWED THE SECOND HALF
 *
 * "4 carried no cost estimate, so the total below understates the true figure."
 * The caller passed no token estimates, so no decision could be costed and the
 * total read $0.00. The page was being honest about a number it had no inputs
 * for. Estimating them is the other half of making the surface mean something.
 *
 * WHY THIS IS CONSERVATIVE
 *
 * Downgrading a task to a weaker model is a quality decision, not just a cost
 * one, and a wrong answer produced cheaply is more expensive than a right one
 * produced dearly. So `large` remains the default and a task drops to `small`
 * on exactly one signal: a short INHERITED plan, which is a replay of steps
 * that already succeeded. Everything else stays where it is today, so this
 * changes nothing for exploring runs.
 *
 * Pure, so the policy can be argued with and changed without touching the
 * executor.
 */
import type { CapabilityTier } from "@/lib/ai/models/types";

export interface TaskShape {
  /** True when the plan came from shared memory rather than exploration. An
   *  inherited plan has already been validated by a successful run. */
  inherited: boolean;
  /** How many Brain snippets grounded the run. Recorded for observability; it
   *  deliberately does not downgrade a run on its own — see below. */
  groundingSnippets: number;
  /** Steps in the plan. A long plan compounds any weakness in the model. */
  stepCount: number;
  /** Characters of instruction text, as a rough proxy for how much the model
   *  has to hold at once. */
  instructionChars: number;
}

export interface TierDecision {
  tier: CapabilityTier;
  /** Why, in one line, so an operator reading the cost page can tell a
   *  deliberate downgrade from a bug. */
  reason: string;
}

/** A plan longer than this is not mechanical, whatever else is true of it. */
const MECHANICAL_STEP_LIMIT = 4;
/** Beyond this the model is holding a lot of context at once. */
const LONG_INSTRUCTION_CHARS = 4000;

export function tierForTask(shape: TaskShape): TierDecision {
  if (shape.stepCount > MECHANICAL_STEP_LIMIT || shape.instructionChars > LONG_INSTRUCTION_CHARS) {
    return { tier: "large", reason: "the plan is long enough that a weaker model would compound its mistakes" };
  }

  if (shape.inherited) {
    // The strongest signal available. An inherited plan is a replay of steps
    // that already succeeded, so the model is following rather than deciding.
    return { tier: "small", reason: "the plan was inherited from a previous successful run, so it is a replay" };
  }

  // Grounding deliberately does NOT downgrade an exploring run.
  //
  // The first version did, on the reasoning that a grounded answer is assembled
  // rather than worked out. An existing executor test disagreed, and it was
  // right: an exploring run is precisely where the reasoning happens, and its
  // plan can be PROMOTED and replayed by later runs. Getting it wrong once
  // cheaply poisons every replay that inherits it, which is the opposite of a
  // saving. Grounding makes an exploring run better, not more mechanical.
  return { tier: "large", reason: "an exploring run decides the plan, and that plan may be reused, so it takes the more capable model" };
}

/**
 * Rough token estimates, so a decision can be costed at all.
 *
 * Deliberately crude: four characters per token is the usual approximation, and
 * a better estimate would need a tokenizer this path has no reason to load. It
 * is labelled ESTIMATED everywhere it surfaces, and an approximate figure that
 * says so beats the $0.00 the page shows with no inputs — which reads as free.
 */
export function estimateTokens(shape: {
  goalChars: number;
  instructionChars: number;
  groundingChars: number;
}): { estInputTokens: number; estOutputTokens: number } {
  const inputChars = shape.goalChars + shape.instructionChars + shape.groundingChars;
  const estInputTokens = Math.max(200, Math.ceil(inputChars / 4));
  // Agent steps produce short, structured answers far more often than essays.
  const estOutputTokens = Math.max(150, Math.ceil(estInputTokens * 0.25));
  return { estInputTokens, estOutputTokens };
}
