/**
 * What the same work would have cost on someone else's model.
 *
 * WHY THIS IS WORTH SHOWING. "We spent 77 cents" means nothing on its own. It
 * means something next to what the identical token count would have cost had
 * every call gone to a premium model, which is what a product that routes
 * everything to one big model actually does.
 *
 * WHAT IT ASSUMES, STATED PLAINLY BECAUSE IT MATTERS. It holds the token count
 * fixed and changes only the price. A different model would not use exactly the
 * same tokens: a more capable one often answers in fewer, a chattier one in
 * more. So this is not a prediction of another product's bill, it is the cost
 * of OUR traffic at THEIR published rates, which is the only comparison we can
 * make from our own data without guessing at someone else's behaviour.
 *
 * THE LARGER SAVING IS NOT ON THIS TABLE. Only a small share of answers reach a
 * model at all; the rest are read straight from connected systems. Routing to a
 * cheaper model is the smaller half of the efficiency story and the table below
 * only shows that half. The share answered without a model is reported
 * separately, and it is the number that actually moves the bill.
 *
 * PRICES ARE PUBLISHED LIST RATES, DATED. They change, and they are not what a
 * company with a negotiated agreement pays. Presenting a stale rate as current
 * would be the same class of error as presenting an unmeasured figure as zero,
 * so the date is carried through to the page rather than living only here.
 */

/** Published list price per million tokens, in USD. */
export interface ModelPrice {
  /** How a reader would name it, not the API identifier. */
  label: string;
  inputPerMillion: number;
  outputPerMillion: number;
  /** Shown so a reader can see which tier is being compared. */
  tier: "premium" | "mid" | "economy";
}

/**
 * The date these rates were recorded.
 *
 * Carried to the page. A comparison against prices nobody has checked in six
 * months is worse than no comparison, because it looks current.
 */
export const PRICES_RECORDED_ON = "2026-08-28";

/**
 * List prices as published by each vendor on the date above.
 *
 * Deliberately a small set: one flagship, one mid-tier and one economy model
 * from the two vendors a client will have heard of, plus the model we actually
 * use. A table of fifteen is a table nobody reads.
 */
export const COMPARISON_PRICES: ModelPrice[] = [
  { label: "Claude Opus", inputPerMillion: 15, outputPerMillion: 75, tier: "premium" },
  { label: "GPT-4o", inputPerMillion: 2.5, outputPerMillion: 10, tier: "premium" },
  { label: "Claude Sonnet", inputPerMillion: 3, outputPerMillion: 15, tier: "mid" },
  { label: "Gemini Pro", inputPerMillion: 1.25, outputPerMillion: 5, tier: "mid" },
  { label: "Claude Haiku", inputPerMillion: 0.8, outputPerMillion: 4, tier: "economy" },
];

export interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** What we actually paid, from the completion log. */
  actualUsd: number;
}

export interface CostComparison {
  label: string;
  tier: ModelPrice["tier"];
  wouldHaveCostUsd: number;
  /** How many times our actual spend this would have been. Null when we spent
   *  nothing measurable, because dividing by it would invent a ratio. */
  multipleOfActual: number | null;
}

/**
 * Cost the same tokens at each vendor's list price.
 *
 * Returns an empty list when there is no usage to compare, rather than a table
 * of zeros. A zero row would read as "this model is free", which is the kind of
 * confident wrong number this whole dashboard is built to avoid.
 */
export function compareCosts(
  usage: TokenUsage,
  prices: ModelPrice[] = COMPARISON_PRICES,
): CostComparison[] {
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return [];

  return prices
    .map((p) => {
      const cost =
        (usage.inputTokens / 1_000_000) * p.inputPerMillion +
        (usage.outputTokens / 1_000_000) * p.outputPerMillion;
      return {
        label: p.label,
        tier: p.tier,
        wouldHaveCostUsd: Math.round(cost * 100) / 100,
        /* Null rather than Infinity when we spent nothing measurable. A ratio
           against zero is not a fact about efficiency. */
        multipleOfActual:
          usage.actualUsd > 0 ? Math.round((cost / usage.actualUsd) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.wouldHaveCostUsd - a.wouldHaveCostUsd);
}
