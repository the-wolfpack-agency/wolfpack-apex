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
