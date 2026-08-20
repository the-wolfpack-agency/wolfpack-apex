/**
 * Comparison, tested for the claims a person would repeat from it.
 *
 * Somebody will take "the cheap model is fine for this and saves $0.02 a call"
 * into a meeting. So the assertions here are about the RECOMMENDATION being
 * defensible: never a model that produced nothing, never a saving computed from
 * a leg that did not run, and never a refused leg quietly missing from the list.
 */
import { runComparison, COMPARISON_MAX_TOKENS } from "../comparison";
import type { AICompleteRequest, AICompleteResponse } from "../types";

function response(over: Partial<AICompleteResponse> = {}): AICompleteResponse {
  return {
    content: "The invoice total is $4,200.",
    model_used: "claude-haiku-4-5",
    provider_used: "anthropic",
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
    latency_ms: 400,
    ...over,
  };
}

/** A completion stub that answers per tier. */
function byTier(map: Record<string, Partial<AICompleteResponse> | Error>) {
  return jest.fn(async (req: AICompleteRequest) => {
    const hit = map[req.model_tier];
    if (hit instanceof Error) throw hit;
    return response({ model_used: `model-${req.model_tier}`, ...hit });
  });
}

const base = { prompt: "what is the invoice total?", tiers: ["cheap", "premium"] as const };

describe("runComparison", () => {
  it("runs one leg per tier and reports what each cost", async () => {
    const complete = byTier({
      cheap: { cost_usd: 0.001 },
      premium: { cost_usd: 0.04 },
    });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.legs).toHaveLength(2);
    expect(r.totalCostUsd).toBeCloseTo(0.041);
  });

  it("deduplicates tiers, so a repeated tier is not billed twice", async () => {
    const complete = byTier({ cheap: {} });
    await runComparison({ prompt: "q", tiers: ["cheap", "cheap", "cheap"] }, complete);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("runs legs in order, so the budget governor is not outrun", async () => {
    /* Firing N calls at once would judge every leg against a spend figure taken
       before any of the others had been billed, letting a workspace one call
       from its ceiling spend N. */
    const order: string[] = [];
    const complete = jest.fn(async (req: AICompleteRequest) => {
      order.push(`start:${req.model_tier}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${req.model_tier}`);
      return response();
    });
    await runComparison({ prompt: "q", tiers: ["cheap", "standard"] }, complete);
    expect(order).toEqual(["start:cheap", "end:cheap", "start:standard", "end:standard"]);
  });

  it("recommends the cheapest leg that PASSED, not the cheapest leg", async () => {
    /* Cheapest overall would recommend the model that produced nothing, which
       is the cheapest answer available and worth exactly what it costs. */
    const complete = byTier({
      cheap: { content: "", cost_usd: 0.0001 },
      premium: { content: "The invoice total is $4,200.", cost_usd: 0.04 },
    });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.cheapestSufficient).toBe("model-premium");
  });

  it("recommends the cheap model when it did the job", async () => {
    // The finding the whole router rests on, measured rather than argued.
    const complete = byTier({ cheap: { cost_usd: 0.001 }, premium: { cost_usd: 0.04 } });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.cheapestSufficient).toBe("model-cheap");
    expect(r.savingPerCallUsd).toBeCloseTo(0.039);
  });

  it("REPORTS a refused leg instead of dropping it", async () => {
    /* A budget refusal shown as a missing row reads as a model that was never
       offered, which is a different and untrue claim. */
    const complete = byTier({
      cheap: {},
      premium: new Error("Workspace is over its monthly AI budget"),
    });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.legs).toHaveLength(2);
    expect(r.legs[1].failed?.reason).toMatch(/budget/i);
  });

  it("excludes a failed leg from cost and from the recommendation", async () => {
    const complete = byTier({ cheap: { cost_usd: 0.001 }, premium: new Error("down") });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.totalCostUsd).toBeCloseTo(0.001);
    expect(r.cheapestSufficient).toBe("model-cheap");
    // One leg ran, so there is no saving to claim against anything.
    expect(r.savingPerCallUsd).toBeNull();
  });

  it("claims no saving when only one leg ran", async () => {
    const complete = byTier({ cheap: {} });
    const r = await runComparison({ prompt: "q", tiers: ["cheap"] }, complete);
    expect(r.savingPerCallUsd).toBeNull();
  });

  it("never reports a negative saving", async () => {
    // The cheapest passing leg being the dearest leg is a real outcome, and it
    // is a saving of zero rather than a penalty.
    const complete = byTier({
      cheap: { content: "", cost_usd: 0.0001 },
      premium: { cost_usd: 0.04 },
    });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.savingPerCallUsd).toBe(0);
  });

  it("returns nothing recommendable when no leg passed", async () => {
    const complete = byTier({ cheap: { content: "" }, premium: { content: "" } });
    const r = await runComparison({ ...base, tiers: [...base.tiers] }, complete);
    expect(r.cheapestSufficient).toBeNull();
  });
});

describe("runComparison — it cannot be a way around the gates", () => {
  it("carries sensitivity onto every leg", async () => {
    const complete = byTier({ cheap: {}, premium: {} });
    await runComparison({ ...base, tiers: [...base.tiers], sensitivity: "phi" }, complete);
    for (const call of complete.mock.calls) expect(call[0].sensitivity).toBe("phi");
  });

  it("carries the residency requirement onto every leg", async () => {
    const complete = byTier({ cheap: {}, premium: {} });
    await runComparison({ ...base, tiers: [...base.tiers], residency: ["eu"] }, complete);
    for (const call of complete.mock.calls) expect(call[0].residency).toEqual(["eu"]);
  });

  it("bounds what each leg may write", async () => {
    const complete = byTier({ cheap: {} });
    await runComparison({ prompt: "q", tiers: ["cheap"] }, complete);
    expect(complete.mock.calls[0][0].max_tokens).toBe(COMPARISON_MAX_TOKENS);
  });

  it("tags every leg so comparison spend is separable from real traffic", async () => {
    const complete = byTier({ cheap: {} });
    await runComparison(
      { prompt: "q", tiers: ["cheap"], metadata: { feature: "assistant" } },
      complete,
    );
    expect(complete.mock.calls[0][0].metadata?.feature).toBe("assistant.compare");
  });
});
