/**
 * Multi-model benchmark harness: run the same prompts across models and grade
 * them side by side, reusing gradeRuns (no second grader). Pure orchestration -
 * the pipeline execution is injected, so these are hermetic (no model calls).
 */
import {
  availableBenchmarkModels,
  runModelBenchmark,
  rankModels,
  type BenchmarkModel,
} from "@/lib/ai-code/model-benchmark";
import type { PipelineRunRecord } from "@/lib/ai-code/grading";
import type { ModelGrade } from "@/lib/ai-code/grading";

describe("availableBenchmarkModels", () => {
  it("includes a model whose env is configured and excludes one that is not", () => {
    // OpenAI models gate on OPENAI_API_KEY; with it present, gpt-4o-mini is available.
    const withKey = availableBenchmarkModels({ OPENAI_API_KEY: "sk-test" });
    expect(withKey.some((m) => m.pin === "gpt-4o-mini")).toBe(true);
    // With NO provider keys at all, the OpenAI model drops out.
    const withoutKey = availableBenchmarkModels({});
    expect(withoutKey.some((m) => m.pin === "gpt-4o-mini")).toBe(false);
  });

  it("returns pin + provider + tier + label for each model", () => {
    const models = availableBenchmarkModels({ OPENAI_API_KEY: "sk-test" });
    const m = models.find((x) => x.pin === "gpt-4o-mini")!;
    expect(m).toMatchObject({ pin: "gpt-4o-mini", provider: "openai", label: "gpt-4o-mini" });
    expect(typeof m.tier).toBe("string");
  });
});

const MODELS: BenchmarkModel[] = [
  { pin: "cheap-model", provider: "azure", tier: "small", label: "cheap-model" },
  { pin: "strong-model", provider: "anthropic", tier: "large", label: "strong-model" },
];

/** A stub run: cheap-model struggles (needs_human), strong-model is clean. */
function stubRun(prompt: string, model: BenchmarkModel): Promise<PipelineRunRecord | null> {
  const clean = model.pin === "strong-model";
  return Promise.resolve({
    model: "WILL_BE_OVERWRITTEN", // the harness attributes to model.label
    status: clean ? "ready_for_pr" : "needs_human",
    attempts: clean ? 0 : 2,
    finalOutcome: clean ? "allow" : "block",
    deepScanCritical: clean ? 0 : 1,
    selfHealed: false,
    costUsd: model.pin === "cheap-model" ? 0.0005 : 0.02,
  });
}

describe("runModelBenchmark", () => {
  it("runs every prompt on every model and groups the grade per model", async () => {
    const res = await runModelBenchmark({
      prompts: ["add a clamp helper", "add an isPalindrome helper"],
      models: MODELS,
      batchId: "bench-1",
      runOne: stubRun,
    });
    expect(res.records).toHaveLength(4); // 2 prompts x 2 models
    expect(res.perModel).toHaveLength(2);
    expect(res.misses).toBe(0);

    const cheap = res.perModel.find((m) => m.model === "cheap-model")!;
    const strong = res.perModel.find((m) => m.model === "strong-model")!;
    expect(cheap.n).toBe(2);
    expect(strong.n).toBe(2);
    // The grade comes from gradeRuns: strong is clean, cheap is blocked.
    expect(strong.readyRate).toBe(1);
    expect(cheap.readyRate).toBe(0);
    expect(cheap.blockRate).toBe(1);
  });

  it("attributes each record to the model's label (not whatever runOne returned)", async () => {
    const res = await runModelBenchmark({ prompts: ["x"], models: MODELS, batchId: "b", runOne: stubRun });
    expect(res.records.every((r) => r.model === "cheap-model" || r.model === "strong-model")).toBe(true);
    expect(res.records.some((r) => r.model === "WILL_BE_OVERWRITTEN")).toBe(false);
  });

  it("counts a null run (skipped/failed) as a miss, not a record", async () => {
    const res = await runModelBenchmark({
      prompts: ["x", "y"],
      models: [MODELS[0]],
      batchId: "b",
      runOne: (_p, _m) => Promise.resolve(null),
    });
    expect(res.records).toHaveLength(0);
    expect(res.misses).toBe(2);
    expect(res.perModel).toHaveLength(0);
  });
});

describe("rankModels", () => {
  const grade = (over: Partial<ModelGrade>): ModelGrade => ({
    model: "m",
    n: 5,
    readyRate: 0.5,
    firstPassRate: 0.4,
    blockRate: 0,
    recoveryRate: 0,
    avgCostUsd: 0.01,
    pricedShare: 1,
    failureProfile: { phantomImports: 0, brokenLocalImports: 0, incompleteFiles: 0, removedExports: 0, anchorFailures: 0, deepScanCritical: 0 },
    ...over,
  });

  it("ranks highest readyRate first", () => {
    const ranked = rankModels([grade({ model: "lo", readyRate: 0.3 }), grade({ model: "hi", readyRate: 0.9 })]);
    expect(ranked[0].model).toBe("hi");
  });

  it("breaks a readyRate tie by cheapest priced model", () => {
    const ranked = rankModels([
      grade({ model: "pricey", readyRate: 0.8, firstPassRate: 0.8, avgCostUsd: 0.05 }),
      grade({ model: "cheap", readyRate: 0.8, firstPassRate: 0.8, avgCostUsd: 0.001 }),
    ]);
    expect(ranked[0].model).toBe("cheap");
  });

  it("sorts an unpriced model after an equally-good priced one (unknown cost != free)", () => {
    const ranked = rankModels([
      grade({ model: "unpriced", readyRate: 0.8, firstPassRate: 0.8, pricedShare: 0, avgCostUsd: 0 }),
      grade({ model: "priced", readyRate: 0.8, firstPassRate: 0.8, pricedShare: 1, avgCostUsd: 0.01 }),
    ]);
    expect(ranked[0].model).toBe("priced");
  });
});
