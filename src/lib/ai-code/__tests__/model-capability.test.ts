/**
 * Empirical model capability: observed capability from gate labels, declared-vs-
 * observed mismatch, and cost-efficient routing advice. All pure.
 */
import {
  observedCapability, capabilityMismatch, recommendModel,
  MIN_SAMPLE, type ObservedCapability,
} from "@/lib/ai-code/model-capability";
import type { ModelLimitationProfile } from "@/lib/ai-code/benchmark-score";

/** Build a profile with a given authoringTasks + per-class withheld counts. */
function profile(
  model: string,
  authoringTasks: number,
  limitations: Record<string, number>,
  extra: Partial<ModelLimitationProfile> = {},
): ModelLimitationProfile {
  const lims: ModelLimitationProfile["limitations"] = {};
  for (const [k, count] of Object.entries(limitations)) {
    lims[k] = { count, rate: authoringTasks > 0 ? count / authoringTasks : 0 };
  }
  return {
    model,
    cases: authoringTasks,
    authoringTasks,
    firstPassRate: 0.5,
    escalationRate: 0,
    expectationMatchRate: 1,
    limitations: lims,
    ...extra,
  };
}

describe("observedCapability", () => {
  it("a clean model reads as observed 'large' (low limitation rate)", () => {
    const o = observedCapability(profile("big", 10, {})); // never withheld
    expect(o.limitationRate).toBe(0);
    expect(o.observedTier).toBe("large");
    expect(o.confident).toBe(true);
  });
  it("a model withheld on most authoring tasks reads 'small'", () => {
    const o = observedCapability(profile("tiny", 10, { "broken-imports": 5, duplication: 1 }));
    expect(o.limitationRate).toBeCloseTo(0.6, 5);
    expect(o.observedTier).toBe("small");
  });
  it("a small sample is not confident (read stays provisional)", () => {
    const o = observedCapability(profile("new", MIN_SAMPLE - 1, {}));
    expect(o.confident).toBe(false);
  });
  it("zero authoring tasks -> neutral 'mid', not a false 'large'", () => {
    const o: ObservedCapability = observedCapability(profile("unseen", 0, {}));
    expect(o.sample).toBe(0);
    expect(o.observedTier).toBe("mid");
    expect(o.confident).toBe(false);
  });
});

describe("capabilityMismatch (declared vs observed - the moat insight)", () => {
  it("flags a 'large'-declared model that performs below its class", () => {
    const m = capabilityMismatch("large", profile("gpt-4o", 10, { "broken-imports": 6 }));
    expect(m.observedTier).toBe("small");
    expect(m.verdict).toBe("below"); // tagged large, measures small
  });
  it("a 'small'-declared model that stays clean punches above its class", () => {
    const m = capabilityMismatch("small", profile("mini", 10, {}));
    expect(m.observedTier).toBe("large");
    expect(m.verdict).toBe("above");
  });
  it("matching declared and observed reads 'matches'", () => {
    const m = capabilityMismatch("small", profile("mini", 10, { "broken-imports": 5 }));
    expect(m.verdict).toBe("matches"); // declared small, observed small
  });
  it("an unproven (small-sample) model is 'unproven', never used to override", () => {
    const m = capabilityMismatch("large", profile("fresh", 2, { "broken-imports": 2 }));
    expect(m.verdict).toBe("unproven");
  });
});

describe("recommendModel (cost-efficient routing advice)", () => {
  const profiles = [
    profile("mini", 10, { "broken-imports": 6 }),   // weak on imports (60%)
    profile("mid", 10, { "broken-imports": 1 }),    // decent on imports (10%)
    profile("big", 10, {}),                          // clean (0%)
  ];
  const candidates = [
    { model: "mini", costRank: 1 },
    { model: "mid", costRank: 2 },
    { model: "big", costRank: 3 },
  ];

  it("picks the CHEAPEST model that clears the stressed class", () => {
    const a = recommendModel(["broken-imports"], candidates, profiles);
    expect(a.model).toBe("mid"); // mini (60%) fails the 30% ceiling; mid (10%) clears and is cheaper than big
  });
  it("routes up only when no cheaper model clears", () => {
    // task stresses a class mini AND mid both fail
    const harder = [
      profile("mini", 10, { duplication: 5 }),
      profile("mid", 10, { duplication: 4 }),
      profile("big", 10, { duplication: 0 }),
    ];
    const a = recommendModel(["duplication"], candidates, harder);
    expect(a.model).toBe("big");
  });
  it("falls back to the cheapest candidate when there is no telemetry", () => {
    const a = recommendModel(["broken-imports"], candidates, []);
    expect(a.model).toBe("mini"); // cheapest, flagged unproven
    expect(a.reason).toMatch(/no limitation telemetry/i);
  });
  it("a model with no profile is not treated as proven-clearing", () => {
    const a = recommendModel(["broken-imports"], [{ model: "ghost", costRank: 0 }], profiles);
    // ghost has no profile -> not proven -> falls to most-capable proven, but ghost
    // is the only candidate and is unproven -> cheapest fallback returns ghost.
    expect(a.model).toBe("ghost");
    expect(a.considered[0].proven).toBe(false);
  });
});
