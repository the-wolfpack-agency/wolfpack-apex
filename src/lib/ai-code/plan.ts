/**
 * Multi-step autonomy - PROPOSE-ONLY plan decomposition.
 *
 * A single factory run authors ONE change. A real goal ("add rate limiting with
 * per-tenant quotas, metrics, and an admin view") is several changes. Today the
 * operator has to decompose that by hand into separate prompts. This turns a goal
 * into an ordered plan of the smallest independently-shippable steps.
 *
 * POSTURE - the whole point, and the gate (user decision 2026-10): the plan NEVER
 * executes itself. It is a list of proposed prompts. A human reviews the plan and
 * launches each step through the EXISTING governed pipeline (author -> gate ->
 * human-approve -> PR). So multi-step autonomy adds NO new execution path and NO
 * new blast radius: every step is still one governed run a human chose to start.
 * "Propose-only" is enforced structurally - this module cannot run a step, it only
 * returns text.
 *
 * Pure except proposePlan(), which takes an INJECTED complete() so it unit-tests
 * hermetically. Parsing is deterministic and NEVER throws: a malformed model
 * response yields an empty plan, not a crash.
 */
import type { AICompleteRequest, AICompleteResponse } from "@/lib/ai/types";
import { AI_CODE_PLAN_PROMPT } from "@/lib/prompts/definitions/ai-code-plan";

/** One proposed step. `instruction` is a self-contained prompt for the pipeline. */
export interface PlanStep {
  /** Stable 1-based id ("step-1"), assigned deterministically after validation. */
  id: string;
  title: string;
  /** The self-contained change prompt a human can hand to the factory as-is. */
  instruction: string;
  /** One line on why this step and why here in the order. May be empty. */
  rationale: string;
  /** The model flagged this step as touching a sensitive surface (auth, crypto,
   *  migrations, security). Advisory - the gate still decides on execution. */
  sensitive: boolean;
}

export interface ProposedPlan {
  goal: string;
  steps: PlanStep[];
  /** The model proposed more than MAX_PLAN_STEPS and the tail was dropped. */
  truncated: boolean;
  /** Concrete model id that produced the plan, or null on failure. */
  model: string | null;
}

/** A goal yielding more steps than this is almost certainly under-scoped; cap it. */
export const MAX_PLAN_STEPS = 12;

/** The user turn: the goal plus any optional grounding (repo, constraints). */
export function composePlanPrompt(goal: string, context?: string): string {
  const g = goal.trim();
  const ctx = (context ?? "").trim();
  return ctx ? `GOAL:\n${g}\n\nCONTEXT:\n${ctx}` : `GOAL:\n${g}`;
}

/** Extract the first top-level JSON array from a model response. Null if none. */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function cleanLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

/**
 * Parse a model response into validated, ordered, de-duplicated steps. Deterministic
 * and NEVER throws. Drops items without a usable title+instruction, dedupes by
 * normalized title, caps to MAX_PLAN_STEPS, and assigns stable ids.
 */
export function parsePlanResponse(raw: string): { steps: PlanStep[]; truncated: boolean } {
  const json = extractJsonArray(raw ?? "");
  if (!json) return { steps: [], truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { steps: [], truncated: false };
  }
  if (!Array.isArray(parsed)) return { steps: [], truncated: false };

  const seen = new Set<string>();
  const valid: Omit<PlanStep, "id">[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = cleanLine(o.title);
    const instruction = cleanLine(o.instruction);
    if (!title || !instruction) continue; // a step with no action is not a step
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ title, instruction, rationale: cleanLine(o.rationale), sensitive: o.sensitive === true });
  }

  const truncated = valid.length > MAX_PLAN_STEPS;
  const steps = valid.slice(0, MAX_PLAN_STEPS).map((s, i) => ({ id: `step-${i + 1}`, ...s }));
  return { steps, truncated };
}

/** Injected model call: same shape the pipeline passes (getAIClient().complete). */
export type CompleteFn = (req: AICompleteRequest) => Promise<AICompleteResponse>;

/**
 * Propose a plan for a goal. Best-effort and NEVER throws: on any model/parse
 * failure it returns an empty plan (the caller shows "could not plan - try
 * rephrasing", never a 500). Uses the cheap tier - decomposition is a light task
 * and the cost-first posture applies.
 */
export async function proposePlan(args: {
  complete: CompleteFn;
  goal: string;
  context?: string;
  maxTokens?: number;
}): Promise<ProposedPlan> {
  const goal = args.goal.trim();
  const base: ProposedPlan = { goal, steps: [], truncated: false, model: null };
  if (!goal) return base;
  try {
    const resp = await args.complete({
      system: AI_CODE_PLAN_PROMPT.render({}),
      messages: [{ role: "user", content: composePlanPrompt(goal, args.context) }],
      max_tokens: args.maxTokens ?? 1500,
      model_tier: "cheap",
      sensitivity: "confidential",
      metadata: { feature: "ai-code-plan" },
    });
    const { steps, truncated } = parsePlanResponse(resp?.content ?? "");
    return { goal, steps, truncated, model: resp?.model_used || resp?.provider_used || null };
  } catch {
    return base;
  }
}
