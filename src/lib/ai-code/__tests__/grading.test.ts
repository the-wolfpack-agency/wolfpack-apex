/**
 * Grading + drift for the factory. Pure over run records. Grades must compute
 * ready/first-pass/block/escalation correctly overall and per model; drift must
 * flag a real degradation and stay quiet on noise or thin samples.
 */
import { gradeRuns, detectDrift, type PipelineRunRecord } from "../grading";

const run = (over: Partial<PipelineRunRecord>): PipelineRunRecord => ({
  model: "gpt-4o-mini",
  status: "ready_for_pr",
  attempts: 0,
  finalOutcome: "allow",
  ...over,
});

describe("gradeRuns", () => {
  it("computes overall ready / first-pass / block / escalation rates", () => {
    const g = gradeRuns([
      run({}), // ready, first-pass
      run({ status: "ready_for_pr", attempts: 1, finalOutcome: "allow" }), // ready, but repaired
      run({ status: "needs_human", attempts: 2, finalOutcome: "block" }), // blocked
      run({ status: "needs_human", attempts: 2, finalOutcome: "escalate" }), // escalated
    ]);
    expect(g.total).toBe(4);
    expect(g.readyRate).toBeCloseTo(0.5);
    expect(g.firstPassRate).toBeCloseTo(0.25);
    expect(g.blockRate).toBeCloseTo(0.25);
    expect(g.escalationRate).toBeCloseTo(0.75); // 3 of 4 either repaired or needs_human
  });

  it("breaks grades down per model, most-active first", () => {
    const g = gradeRuns([
      run({ model: "cheap" }),
      run({ model: "cheap", status: "needs_human", attempts: 1, finalOutcome: "block" }),
      run({ model: "premium" }),
    ]);
    expect(g.byModel[0].model).toBe("cheap"); // more runs
    expect(g.byModel[0].readyRate).toBeCloseTo(0.5);
    expect(g.byModel.find((m) => m.model === "premium")?.firstPassRate).toBe(1);
  });

  it("is safe on empty input", () => {
    expect(gradeRuns([]).readyRate).toBe(0);
  });
});

describe("model capability profile (recovery, cost, failure fingerprint)", () => {
  it("recoveryRate = self-healed / (self-healed + needs_human), ignoring clean runs", () => {
    const g = gradeRuns([
      run({ selfHealed: true, attempts: 1 }),   // erred, recovered
      run({ selfHealed: true, attempts: 1 }),   // erred, recovered
      run({ status: "needs_human", attempts: 1, finalOutcome: "block" }), // erred, stuck
      run({}),                                   // clean first-pass (must NOT dilute)
    ]);
    // 2 recovered of 3 that hit trouble
    expect(g.recoveryRate).toBeCloseTo(2 / 3);
  });

  it("avgCostUsd averages the per-run cost; pricedShare is 1 when all priced", () => {
    const g = gradeRuns([run({ costUsd: 0.02 }), run({ costUsd: 0.04 })]);
    expect(g.avgCostUsd).toBeCloseTo(0.03);
    expect(g.pricedShare).toBe(1);
  });

  it("a $0 / absent cost is UNPRICED, not free: excluded from avgCostUsd, dropped pricedShare", () => {
    // An unpriced Foundry model (no price env) records cost 0; it must not read
    // as infinitely cost-effective. One priced run at 0.02 among three.
    const g = gradeRuns([run({ costUsd: 0.02 }), run({ costUsd: 0 }), run({})]);
    expect(g.avgCostUsd).toBeCloseTo(0.02); // averaged over the ONE priced run
    expect(g.pricedShare).toBeCloseTo(1 / 3);
  });

  it("a fully unpriced model reports pricedShare 0 (avgCostUsd is not meaningful)", () => {
    const g = gradeRuns([run({ model: "DeepSeek", costUsd: 0 }), run({ model: "DeepSeek", costUsd: 0 })]);
    const ds = g.byModel.find((m) => m.model === "DeepSeek")!;
    expect(ds.pricedShare).toBe(0);
    expect(ds.avgCostUsd).toBe(0); // 0 priced runs -> rate() guards to 0, read via pricedShare
  });

  it("failureProfile is the fraction of runs that trip each gate (the fingerprint)", () => {
    const g = gradeRuns([
      run({ brokenLocalImports: 2 }),
      run({ brokenLocalImports: 1, removedExports: 1 }),
      run({}),
      run({}),
    ]);
    expect(g.failureProfile.brokenLocalImports).toBeCloseTo(0.5); // 2 of 4
    expect(g.failureProfile.removedExports).toBeCloseTo(0.25);    // 1 of 4
    expect(g.failureProfile.phantomImports).toBe(0);
  });

  it("separates two models' fingerprints: cheap trips imports, premium is clean", () => {
    const g = gradeRuns([
      run({ model: "cheap", brokenLocalImports: 1, status: "needs_human", finalOutcome: "block" }),
      run({ model: "cheap", selfHealed: true, attempts: 1, brokenLocalImports: 0 }),
      run({ model: "premium" }),
      run({ model: "premium" }),
    ]);
    const cheap = g.byModel.find((m) => m.model === "cheap")!;
    const premium = g.byModel.find((m) => m.model === "premium")!;
    expect(cheap.failureProfile.brokenLocalImports).toBeCloseTo(0.5);
    expect(cheap.recoveryRate).toBeCloseTo(0.5); // 1 recovered of 2 troubled
    expect(premium.failureProfile.brokenLocalImports).toBe(0);
    expect(premium.recoveryRate).toBe(0); // never hit trouble -> 0/0 -> 0
    expect(premium.readyRate).toBe(1);
  });
});

describe("detectDrift", () => {
  it("flags a model whose recent readyRate dropped materially", () => {
    // prior 6 all ready, recent 6 all needs_human -> a clear drop.
    const prior = Array.from({ length: 6 }, (_, i) => run({ model: "m", ts: i, status: "ready_for_pr" }));
    const recent = Array.from({ length: 6 }, (_, i) => run({ model: "m", ts: 100 + i, status: "needs_human", attempts: 2, finalOutcome: "escalate" }));
    const flags = detectDrift([...prior, ...recent], { minSamples: 5, dropThreshold: 0.2 });
    expect(flags).toHaveLength(1);
    expect(flags[0].model).toBe("m");
    expect(flags[0].drop).toBeCloseTo(1);
  });

  it("does NOT flag on too few samples (a bad afternoon is not drift)", () => {
    const recs = [run({ model: "m", ts: 1 }), run({ model: "m", ts: 2, status: "needs_human", finalOutcome: "block" })];
    expect(detectDrift(recs, { minSamples: 5 })).toEqual([]);
  });

  it("does NOT flag a stable model", () => {
    const recs = Array.from({ length: 12 }, (_, i) => run({ model: "m", ts: i, status: "ready_for_pr" }));
    expect(detectDrift(recs, { minSamples: 5 })).toEqual([]);
  });
});
