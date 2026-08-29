/**
 * A downgrade steps down one rung. It does not fall to the floor.
 *
 * THE BUG. Step 3 of selection took the CHEAPEST model of any tier when the
 * requested tier was unavailable. So a request for "reasoning" with no
 * reasoning model configured returned gpt-4o-mini, the smallest model on the
 * board: the maximum possible distance from what was asked, chosen
 * deliberately by the code.
 *
 * Measured in production over sixty days: 5 premium and 82 standard requests
 * served by gpt-4o-mini. The 5 premium calls cost $0.135, the highest
 * per-call cost recorded, for the least capable answer available. Somebody
 * asked for the best model, waited longer, paid more, and got the smallest.
 *
 * Nothing failed. The router returned a model and reported "downgraded", which
 * is true and says nothing about how far it fell.
 */
import { selectModel } from "@/lib/ai/models/router";

/** Production's shape: Azure OpenAI and Azure Foundry, no OpenAI or Anthropic. */
const AZURE_ONLY = {
  NODE_ENV: "test",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_ENDPOINT: "https://example",
  AZURE_OPENAI_DEPLOYMENT_CHEAP: "c",
  AZURE_OPENAI_DEPLOYMENT_STANDARD: "s",
  AZURE_OPENAI_DEPLOYMENT_PREMIUM: "p",
  AZURE_AI_FOUNDRY_ENDPOINT: "https://foundry",
  AZURE_AI_FOUNDRY_API_KEY: "k",
  AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK: "d",
  AZURE_FOUNDRY_DEPLOYMENT_LLAMA: "l",
} as NodeJS.ProcessEnv;

/** Only the smallest model configured, so there is nowhere to step down to. */
const SMALL_ONLY = {
  NODE_ENV: "test",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_ENDPOINT: "https://example",
  AZURE_OPENAI_DEPLOYMENT_CHEAP: "c",
} as NodeJS.ProcessEnv;

describe("when the requested tier is unavailable", () => {
  /* THE ASSERTION THAT MATTERS. Reasoning is unavailable in production because
     o4-mini and Claude both need keys we do not hold. The honest answer is the
     most capable thing we DO have, not the cheapest thing we have. */
  it("gives the most capable model available, not the cheapest", () => {
    const d = selectModel({ requiredTier: "reasoning" }, AZURE_ONLY);
    expect(d.reason).toBe("downgraded_no_tier_available");
    expect(d.model.capabilityTier).toBe("large");
    expect(d.model.id).not.toBe("azure-gpt-4o-mini");
  });

  /* Cost still breaks ties WITHIN the best available tier, so stepping down
     does not become an excuse to spend. Llama and DeepSeek are both large;
     Llama is cheaper. */
  it("still picks the cheapest option within that tier", () => {
    const d = selectModel({ requiredTier: "reasoning" }, AZURE_ONLY);
    expect(d.model.id).toBe("azure-llama-3.3-70b");
  });

  /* When there genuinely is nowhere to step down to, returning the small model
     is right. The rule is "closest to what was asked", not "never small". */
  it("returns the small model when it is the only one there is", () => {
    const d = selectModel({ requiredTier: "reasoning" }, SMALL_ONLY);
    expect(d.model.capabilityTier).toBe("small");
    expect(d.reason).toBe("downgraded_no_tier_available");
  });

  /* It must still SAY it downgraded. A caller that cannot tell it was
     under-served will keep asking for a tier it never receives. */
  it("reports the downgrade rather than passing it off as a match", () => {
    expect(selectModel({ requiredTier: "reasoning" }, AZURE_ONLY).reason).toBe(
      "downgraded_no_tier_available",
    );
  });
});

describe("requests that can be served are unaffected", () => {
  it.each([
    ["small", "small"],
    ["large", "large"],
  ] as const)("serves a %s request at its own tier", (asked, expected) => {
    const d = selectModel({ requiredTier: asked }, AZURE_ONLY);
    expect(d.reason).toBe("cheapest_at_tier");
    expect(d.model.capabilityTier).toBe(expected);
  });

  /* The cheap tier carries 87% of this product's traffic and must keep landing
     on the cheapest model. A fix to the downgrade path that moved this would
     cost real money on every question. */
  it("keeps the cheap path on the cheapest model", () => {
    expect(selectModel({ requiredTier: "small" }, AZURE_ONLY).model.id).toBe(
      "azure-gpt-4o-mini",
    );
  });
});
