/**
 * Multi-model benchmark harness - run the SAME prompt battery across every
 * available model and grade them side by side.
 *
 * WHY: the factory's value compounds with the model-comparison data it generates
 * - "which model is usable, at what cost, failing how" is the product, not a
 * side effect. The pieces already exist: the registry enumerates models
 * (listModels / isModelAvailable), the pipeline records a model-attributed run,
 * and gradeRuns turns run records into per-model metrics (readyRate, firstPass,
 * recovery, cost, failure profile). The ONE missing piece was a driver that runs
 * the same prompts across each model so the comparison is apples-to-apples. This
 * is that driver - and it REUSES gradeRuns for the metrics rather than computing
 * its own (the duplication gate would flag a second grader).
 *
 * Pure orchestration: the actual pipeline execution is injected as `runOne`, so
 * this is deterministic and testable without a model call. The real caller passes
 * a `runOne` that drives the live pipeline (pinned to the model) against the
 * deployed URL - the true, UI-equivalent path - under a budget cap.
 */
import { gradeRuns, type PipelineRunRecord, type ModelGrade } from "./grading";
import { listModels, isModelAvailable, type ModelSpec } from "@/lib/ai/models";

/** A model to benchmark: the pin the pipeline understands + a display label. */
export interface BenchmarkModel {
  /** executorProviderPin / model id the pipeline routes to. */
  pin: string;
  provider: string;
  tier: string;
  /** Label used for grouping in the grade (defaults to pin). */
  label: string;
}

export interface BenchmarkResult {
  batchId: string;
  prompts: readonly string[];
  models: readonly BenchmarkModel[];
  /** Per-model grades (from gradeRuns) - the side-by-side comparison. */
  perModel: readonly ModelGrade[];
  /** Every run record collected, model-attributed. */
  records: readonly PipelineRunRecord[];
  /** (prompt, model) pairs that produced no record (skipped/failed run). */
  misses: number;
}

/**
 * The models worth benchmarking in this environment: every registered model the
 * env is actually configured for (an API key / deployment present). Pure - reads
 * only env-var presence via isModelAvailable. `env` is injectable for tests.
 */
export function availableBenchmarkModels(env: Record<string, string | undefined> = process.env): BenchmarkModel[] {
  return listModels()
    .filter((m: ModelSpec) => isModelAvailable(m, env))
    .map((m) => ({ pin: m.id, provider: m.provider, tier: String(m.capabilityTier), label: m.id }));
}

/**
 * Run `prompts` through every model and grade them side by side. `runOne`
 * executes one (prompt, model) pipeline run and returns its record (or null if
 * the run was skipped/failed). Each record is attributed to the model's label so
 * gradeRuns groups it correctly. Reuses gradeRuns for all metrics.
 */
export async function runModelBenchmark(args: {
  prompts: readonly string[];
  models: readonly BenchmarkModel[];
  batchId: string;
  runOne: (prompt: string, model: BenchmarkModel) => Promise<PipelineRunRecord | null>;
}): Promise<BenchmarkResult> {
  const records: PipelineRunRecord[] = [];
  let misses = 0;
  for (const model of args.models) {
    for (const prompt of args.prompts) {
      const rec = await args.runOne(prompt, model);
      if (rec) records.push({ ...rec, model: model.label });
      else misses++;
    }
  }
  const grade = gradeRuns(records);
  return {
    batchId: args.batchId,
    prompts: args.prompts,
    models: args.models,
    perModel: grade.byModel,
    records,
    misses,
  };
}

/**
 * Rank the per-model grades for a "best usable model" read: highest readyRate
 * first, then first-pass, then (when priced) cheapest. Pure. A model with no
 * priced runs sorts after priced ones at equal quality (its cost is unknown, not
 * zero - mirrors gradeRuns' pricedShare caveat).
 */
export function rankModels(perModel: readonly ModelGrade[]): ModelGrade[] {
  return [...perModel].sort((a, b) => {
    if (b.readyRate !== a.readyRate) return b.readyRate - a.readyRate;
    if (b.firstPassRate !== a.firstPassRate) return b.firstPassRate - a.firstPassRate;
    const aPriced = a.pricedShare > 0;
    const bPriced = b.pricedShare > 0;
    if (aPriced !== bPriced) return aPriced ? -1 : 1;
    if (aPriced && bPriced && a.avgCostUsd !== b.avgCostUsd) return a.avgCostUsd - b.avgCostUsd;
    return a.model.localeCompare(b.model);
  });
}

const TIER_RANK: Record<string, number> = { reasoning: 3, large: 2, small: 1 };

/**
 * The ordered list of model PINS to try when escalating a task the current model
 * couldn't do - stronger tier first, excluding ones already tried. Pins route to a
 * SPECIFIC model (what the benchmark proved), unlike a tier bump, which in a
 * single-deployment Azure environment resolves to the same cheap model. So this is
 * how "route hard work to a model that can actually do it" works with whatever is
 * deployed: try the genuinely-distinct available models (e.g. the Foundry ones) by
 * pin. Pure; reads only availability.
 */
export function escalationModelPins(
  opts: { excludePins?: readonly string[]; env?: Record<string, string | undefined> } = {},
): string[] {
  const exclude = new Set((opts.excludePins ?? []).filter(Boolean));
  return availableBenchmarkModels(opts.env ?? process.env)
    .filter((m) => !exclude.has(m.pin))
    .sort((a, b) => (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || a.label.localeCompare(b.label))
    .map((m) => m.pin);
}
