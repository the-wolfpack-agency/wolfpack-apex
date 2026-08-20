/**
 * The same prompt, across several models, measured.
 *
 * WHY THIS IS NOT A PLAYGROUND
 *
 * Every gateway ships a playground: type a prompt, see two answers, form an
 * opinion. It is a demo, and the opinion it produces evaporates the moment the
 * tab closes, because nothing was recorded and nothing was priced.
 *
 * This runs the same prompt through the SAME chokepoint every production call
 * uses, so each answer arrives redacted, inside the workspace budget, obeying
 * the residency requirement, with an audit row behind it and the provider's own
 * billed figure attached. The output is therefore not an impression. It is
 * evidence: this prompt, on this model, cost this much, took this long, and
 * passed or failed the same rules that guard live traffic.
 *
 * WHAT IT IS ACTUALLY FOR
 *
 * Routing cheap is a claim until somebody checks it on the work they really do.
 * A comparison answers "is the small model good enough for THIS kind of
 * request" with numbers, for a specific team's prompts rather than a benchmark
 * built from somebody else's. That is the argument the whole router rests on,
 * and until now it was made from first principles.
 *
 * COST IS THE POINT AND THE DANGER
 *
 * Comparing N models costs N times one call, so this is never automatic and
 * never a fallback. It runs because a person asked, on a prompt they chose. The
 * budget governor still applies to every leg, so a comparison cannot spend past
 * a ceiling the workspace has already hit: it simply returns fewer results, and
 * says which legs were refused rather than quietly showing a shorter list.
 */
import type { AICompleteRequest, AICompleteResponse, AIModelTier } from "./types";
import { verifyAnswer, type VerificationVerdict } from "./verification";

/** One model's attempt at the prompt. */
export interface ComparisonLeg {
  tier: AIModelTier;
  /** The model that actually answered, as the provider named it. */
  model: string;
  provider: string;
  /** What came back. Empty when the leg failed. */
  answer: string;
  /** The provider's billed figure for this call, in USD. */
  costUsd: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** The same rules that guard live traffic, applied to this answer. */
  verdict: VerificationVerdict;
  /** Present when this leg did not run. The reason is shown, never hidden:
   *  a comparison that silently drops a refused leg reads as a model that was
   *  never offered, which is a different and untrue claim. */
  failed?: { reason: string };
}

export interface ComparisonResult {
  prompt: string;
  legs: ComparisonLeg[];
  /** Total billed across every leg that ran. The price of the knowledge. */
  totalCostUsd: number;
  /** Cheapest leg that passed the rules, when there is one. The finding that
   *  actually changes a routing decision. */
  cheapestSufficient: string | null;
  /** What the cheapest sufficient leg saves against the dearest leg that ran,
   *  per call, in USD. Null when fewer than two legs ran. */
  savingPerCallUsd: number | null;
}

export interface ComparisonInput {
  prompt: string;
  /** Tiers to compare. Deduplicated; order is preserved for display. */
  tiers: AIModelTier[];
  system?: string;
  maxTokens?: number;
  /** Carried onto every leg so a comparison cannot be a way around the gates. */
  sensitivity?: AICompleteRequest["sensitivity"];
  residency?: string[];
  metadata?: AICompleteRequest["metadata"];
}

/** Default ceiling per leg. Comparisons are for judging quality, not for
 *  producing a deliverable, and an unbounded one multiplies its own cost by N. */
export const COMPARISON_MAX_TOKENS = 800;

/**
 * Run the comparison.
 *
 * The completion function is injected so this is testable without a network and
 * so the router remains the only thing that knows how to spend money.
 *
 * SEQUENTIAL, NOT PARALLEL, and that is deliberate. Firing N calls at once
 * would beat the budget governor: each leg would be judged against a spend
 * figure taken before any of the others had been billed, so a workspace one
 * call from its ceiling could spend N. Running in order means leg two is judged
 * against a world in which leg one has already happened.
 */
export async function runComparison(
  input: ComparisonInput,
  complete: (req: AICompleteRequest) => Promise<AICompleteResponse>,
): Promise<ComparisonResult> {
  const tiers = [...new Set(input.tiers)];
  const legs: ComparisonLeg[] = [];

  for (const tier of tiers) {
    const started = Date.now();
    try {
      const res = await complete({
        messages: [{ role: "user", content: input.prompt }],
        ...(input.system ? { system: input.system } : {}),
        max_tokens: input.maxTokens ?? COMPARISON_MAX_TOKENS,
        model_tier: tier,
        ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
        ...(input.residency ? { residency: input.residency } : {}),
        metadata: { ...input.metadata, feature: `${input.metadata?.feature ?? "comparison"}.compare` },
      });
      legs.push({
        tier,
        model: res.model_used,
        provider: res.provider_used,
        answer: res.content,
        costUsd: res.cost_usd,
        latencyMs: res.latency_ms,
        inputTokens: res.input_tokens,
        outputTokens: res.output_tokens,
        verdict: verifyAnswer({ answer: res.content, question: input.prompt }),
      });
    } catch (err) {
      /* A refused or failed leg is REPORTED, not dropped. A budget refusal
         shown as a missing row reads as a model that was never offered. */
      legs.push({
        tier,
        model: "",
        provider: "",
        answer: "",
        costUsd: 0,
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        verdict: { sufficient: false, flags: ["empty"], reason: "This model did not answer." },
        failed: { reason: (err as Error)?.message || "The call failed." },
      });
    }
  }

  const ran = legs.filter((l) => !l.failed);
  const totalCostUsd = ran.reduce((sum, l) => sum + l.costUsd, 0);

  /* Cheapest leg that PASSED. Cheapest overall would recommend a model that
     produced nothing, which is the cheapest answer available and worth what it
     costs. */
  const passed = ran.filter((l) => l.verdict.sufficient);
  const cheapest = passed.length > 0 ? passed.reduce((a, b) => (b.costUsd < a.costUsd ? b : a)) : null;

  let savingPerCallUsd: number | null = null;
  if (cheapest && ran.length >= 2) {
    const dearest = ran.reduce((a, b) => (b.costUsd > a.costUsd ? b : a));
    savingPerCallUsd = Math.max(0, dearest.costUsd - cheapest.costUsd);
  }

  return {
    prompt: input.prompt,
    legs,
    totalCostUsd,
    cheapestSufficient: cheapest?.model ?? null,
    savingPerCallUsd,
  };
}
