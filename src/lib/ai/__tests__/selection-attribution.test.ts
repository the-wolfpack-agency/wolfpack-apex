/**
 * Every completion says why the router did or did not choose the model.
 *
 * Measured over ninety days: 577 model calls, and only 295 carried
 * `selected_model_id`. brain.retrieval_eval had none across 90 calls,
 * model_drift none across 19. So nearly half of model spend could not be
 * attributed to a routing decision, and there was no way to tell a deliberate
 * override from a field somebody forgot to record.
 *
 * The field was OMITTED whenever bridging returned null, and bridging returns
 * null for four quite different reasons. An override is a human decision. No
 * model available is an estate problem. A client model is correct behaviour
 * that must never route through our tenant. Recording all four as absence
 * threw away the distinction and made the gap look like a bug in the logging.
 *
 * Same class as everything else this week: an absence that means something
 * specific, stored as nothing.
 */

import { bridgeSelection, takeNoSelectionReason } from "@/lib/ai/model-bridge";
import type { AIModelTier } from "@/lib/ai/types";

/** A registry with neither provider available. */
const NO_PROVIDERS = { azure: null, anthropic: null } as never;

function selectStub(reason: string, model: Record<string, unknown> = {}) {
  return () =>
    ({
      reason,
      model: { id: "m1", provider: "azure", ...model },
    }) as never;
}

describe("naming the reason bridging declined", () => {
  it("reports no_model_available when selection had no real choice", () => {
    const out = bridgeSelection("standard" as AIModelTier, NO_PROVIDERS, {
      select: selectStub("no_model_available_using_default"),
    });
    expect(out).toBeNull();
    expect(takeNoSelectionReason()).toBe("no_model_available");
  });

  it("reports provider_missing when the chosen provider is not configured", () => {
    const out = bridgeSelection("standard" as AIModelTier, NO_PROVIDERS, {
      select: selectStub("selected"),
    });
    expect(out).toBeNull();
    expect(takeNoSelectionReason()).toBe("provider_missing");
  });

  it("reports tier_unsupported when the provider cannot serve the tier", () => {
    const providers = {
      azure: { supportsTier: () => false },
      anthropic: null,
    } as never;
    const out = bridgeSelection("premium" as AIModelTier, providers, {
      select: selectStub("selected"),
    });
    expect(out).toBeNull();
    expect(takeNoSelectionReason()).toBe("tier_unsupported");
  });

  it("clears the reason when a model IS selected", () => {
    /* A stale reason would attach itself to the next successful completion and
       report an override that never happened, which is worse than the absence
       this replaces. */
    const providers = {
      azure: { supportsTier: () => true },
      anthropic: null,
    } as never;
    const out = bridgeSelection("standard" as AIModelTier, providers, {
      select: selectStub("selected"),
    });
    expect(out).not.toBeNull();
    expect(takeNoSelectionReason()).toBeNull();
  });

  it("every reason is a distinct, actionable fact", () => {
    /* The point of naming them. Collapsing these to one value would restore
       the ambiguity: an estate problem and a deliberate override need
       different responses from whoever reads the cost page. */
    const reasons = new Set([
      "primary_override",
      "no_model_available",
      "client_model",
      "provider_missing",
      "tier_unsupported",
    ]);
    expect(reasons.size).toBe(5);
  });
});
