import {
  evaluateModelRegression,
  makeSuccessRate,
  MIN_SAMPLES_PER_MODEL,
  REGRESSION_THRESHOLD,
  IMPROVEMENT_THRESHOLD,
  type ModelStats,
} from "@/lib/agents/evals/model-eval";

// Build a ModelStats; successRate is derived from succeeded/total so the fixture
// is always internally consistent (an explicit successRate in `over` wins last).
function stat(over: Partial<ModelStats>): ModelStats {
  const total = over.total ?? 10;
  const succeeded = over.succeeded ?? total;
  return {
    model: "m",
    recencyRank: 0,
    ...over,
    total,
    succeeded,
    successRate: over.successRate ?? makeSuccessRate(succeeded, total),
  };
}

describe("makeSuccessRate", () => {
  it("is 0 for zero totals (never NaN)", () => {
    expect(makeSuccessRate(0, 0)).toBe(0);
  });
  it("divides succeeded by total", () => {
    expect(makeSuccessRate(3, 4)).toBe(0.75);
  });
});

describe("evaluateModelRegression", () => {
  it("is insufficient_data with fewer than two models", () => {
    const r = evaluateModelRegression([stat({ model: "gpt-a", recencyRank: 0 })]);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.shouldAlert).toBe(false);
  });

  it("is insufficient_data when a model has too few samples", () => {
    const r = evaluateModelRegression([
      stat({ model: "new", recencyRank: 0, total: MIN_SAMPLES_PER_MODEL - 1, succeeded: 0 }),
      stat({ model: "old", recencyRank: 1, total: 20, succeeded: 20 }),
    ]);
    expect(r.verdict).toBe("insufficient_data");
  });

  it("regresses and alerts when the newest model does materially worse", () => {
    const r = evaluateModelRegression([
      stat({ model: "new", recencyRank: 0, total: 20, succeeded: 10 }), // 0.50
      stat({ model: "old", recencyRank: 1, total: 20, succeeded: 18 }), // 0.90
    ]);
    expect(r.verdict).toBe("regressed");
    expect(r.shouldAlert).toBe(true);
    expect(r.candidateModel).toBe("new");
    expect(r.baselineModel).toBe("old");
    expect(r.delta).toBeCloseTo(-0.4, 5);
    expect(r.delta).toBeLessThanOrEqual(-REGRESSION_THRESHOLD);
  });

  it("improves (no alert) when the newest model does materially better", () => {
    const r = evaluateModelRegression([
      stat({ model: "new", recencyRank: 0, total: 20, succeeded: 19 }), // 0.95
      stat({ model: "old", recencyRank: 1, total: 20, succeeded: 12 }), // 0.60
    ]);
    expect(r.verdict).toBe("improved");
    expect(r.shouldAlert).toBe(false);
    expect(r.delta).toBeGreaterThanOrEqual(IMPROVEMENT_THRESHOLD);
  });

  it("is stable for a change below the threshold", () => {
    const r = evaluateModelRegression([
      stat({ model: "new", recencyRank: 0, total: 20, succeeded: 17 }), // 0.85
      stat({ model: "old", recencyRank: 1, total: 20, succeeded: 18 }), // 0.90
    ]);
    expect(r.verdict).toBe("stable");
    expect(r.shouldAlert).toBe(false);
  });

  it("picks candidate/baseline by recency regardless of input order", () => {
    const r = evaluateModelRegression([
      stat({ model: "old", recencyRank: 2, total: 20, succeeded: 18 }),
      stat({ model: "new", recencyRank: 0, total: 20, succeeded: 10 }),
      stat({ model: "mid", recencyRank: 1, total: 20, succeeded: 17 }),
    ]);
    // newest (rank 0) vs the one before it (rank 1), not the oldest.
    expect(r.candidateModel).toBe("new");
    expect(r.baselineModel).toBe("mid");
  });

  it("sits exactly on the regression threshold boundary", () => {
    const r = evaluateModelRegression([
      stat({ model: "new", recencyRank: 0, total: 100, successRate: 0.7, succeeded: 70 }),
      stat({ model: "old", recencyRank: 1, total: 100, successRate: 0.85, succeeded: 85 }),
    ]);
    // delta = -0.15 = -REGRESSION_THRESHOLD -> regressed (<=).
    expect(r.delta).toBeCloseTo(-REGRESSION_THRESHOLD, 5);
    expect(r.verdict).toBe("regressed");
  });
});
