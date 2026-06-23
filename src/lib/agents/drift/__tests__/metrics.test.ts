import { computeBehaviorMetrics, totalVariationDistance, type DecisionSample } from "@/lib/agents/drift/metrics";

function s(tool: string, riskTier: string, intendedOutcome: string, wouldBlock: boolean): DecisionSample {
  return { tool, riskTier, intendedOutcome, wouldBlock };
}

describe("computeBehaviorMetrics", () => {
  it("computes block rate and distributions that sum to 1", () => {
    const m = computeBehaviorMetrics([
      s("a", "low", "allow", false),
      s("a", "low", "allow", false),
      s("b", "high", "escalate", true),
      s("b", "high", "escalate", true),
    ]);
    expect(m.count).toBe(4);
    expect(m.blockRate).toBe(0.5);
    expect(m.tierDist.low).toBe(0.5);
    expect(m.tierDist.high).toBe(0.5);
    expect(Object.values(m.toolDist).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
  it("is empty-safe", () => {
    const m = computeBehaviorMetrics([]);
    expect(m.count).toBe(0);
    expect(m.blockRate).toBe(0);
    expect(m.tierDist).toEqual({});
  });
});

describe("totalVariationDistance", () => {
  it("is 0 for identical, 1 for disjoint, partial otherwise", () => {
    expect(totalVariationDistance({ a: 1 }, { a: 1 })).toBe(0);
    expect(totalVariationDistance({ a: 1 }, { b: 1 })).toBe(1);
    expect(totalVariationDistance({ a: 0.5, b: 0.5 }, { a: 1 })).toBeCloseTo(0.5);
  });
});
