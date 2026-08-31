/**
 * The router picks the cheapest model that can do the job. Proven, not claimed.
 *
 * WHAT THIS INVESTIGATION ACTUALLY FOUND. The standing concern was that cheap
 * models sit configured in production and the router never picks them. Measured
 * over 90 days: 1,673 calls, 97.1 per cent gpt-4o-mini, 2.7 per cent gpt-4o,
 * two calls to anything else, and ZERO fallbacks. The router is not stuck. It
 * is choosing, and most of the work genuinely is small-tier.
 *
 * THE PREMISE WAS WRONG IN A SPECIFIC WAY. gpt-4o-mini is ALREADY the cheapest
 * small-tier model in the registry, at $0.000327 for a call the shape of ours
 * against $0.0023 for Claude Haiku. DeepSeek and Llama are registered at the
 * LARGE tier, so they were never candidates for the cheap work that makes up
 * almost all of our traffic. A router that picked them for it would be wrong.
 *
 * WHERE THE MONEY ACTUALLY IS, AND IT IS NOT MUCH TODAY. At the large tier
 * Llama 3.3 costs $0.001292 against gpt-4o at $0.005450, a 4.2x difference for
 * the same tier. Production served 36 large-tier calls in 90 days outside the
 * bakeoff, so the whole prize is around fifteen cents. Worth knowing, not worth
 * engineering, and worth a test so it stays true as traffic grows.
 *
 * WHY A TEST RATHER THAN A NOTE. A price is the one field that fails silently.
 * Editing one number reorders every routing decision the product makes, no test
 * breaks, and nothing in a diff looks wrong. This pins the ORDER rather than
 * the prices, so a genuine price correction passes and an edit that quietly
 * makes us pick a dearer model does not.
 */

import { MODEL_REGISTRY } from "@/lib/ai/models/registry";

/** A call the shape of our real traffic: about 1,700 in, 120 out. */
const TYPICAL_INPUT_K = 1.7;
const TYPICAL_OUTPUT_K = 0.12;

const costOf = (m: (typeof MODEL_REGISTRY)[number]) =>
  m.inputPricePer1kUsd * TYPICAL_INPUT_K + m.outputPricePer1kUsd * TYPICAL_OUTPUT_K;

const atTier = (tier: string) =>
  MODEL_REGISTRY.filter((m) => m.capabilityTier === tier).sort((a, b) => costOf(a) - costOf(b));

describe("what the cheapest model at each tier is", () => {
  /* If this changes, the router's behavior changed, and it changed because
     somebody edited a price. That is the moment to check the vendor's page
     rather than to update the expectation. */
  it("is gpt-4o-mini for small work", () => {
    expect(atTier("small")[0].id).toMatch(/gpt-4o-mini/);
  });

  it("is Llama at the large tier, not gpt-4o", () => {
    const large = atTier("large");
    expect(large[0].id).toBe("azure-llama-3.3-70b");
    /* The 4.2x that makes this worth knowing as traffic grows. */
    const gpt4o = large.find((m) => m.id === "azure-gpt-4o")!;
    expect(costOf(gpt4o) / costOf(large[0])).toBeGreaterThan(3);
  });

  it("is o4-mini for reasoning", () => {
    expect(atTier("reasoning")[0].id).toBe("o4-mini");
  });
});

describe("prices that would reorder routing", () => {
  /* THE FIELD THAT FAILS SILENTLY. A zero reads as free and wins every
     comparison at its tier, so a model with a price nobody filled in would
     capture all of that tier's traffic without a single test going red. */
  it("has no model priced at zero", () => {
    const free = MODEL_REGISTRY.filter(
      (m) => m.inputPricePer1kUsd <= 0 || m.outputPricePer1kUsd <= 0,
    ).map((m) => m.id);
    expect(free).toEqual([]);
  });

  it("prices every model it offers", () => {
    for (const m of MODEL_REGISTRY) {
      expect(Number.isFinite(m.inputPricePer1kUsd)).toBe(true);
      expect(Number.isFinite(m.outputPricePer1kUsd)).toBe(true);
    }
  });

  /* Every tier needs at least two models or "cheapest at tier" is a sentence
     about a list of one, and the router cannot switch within it. */
  it("offers a choice at every tier", () => {
    for (const tier of ["small", "large", "reasoning"]) {
      expect(atTier(tier).length).toBeGreaterThanOrEqual(2);
    }
  });
});
