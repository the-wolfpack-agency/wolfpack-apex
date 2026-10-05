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
import { fromModelGrade } from "./model-capability";
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

/** Minimum graded runs before a model's value score is trusted (below it, the
 *  rate is too noisy to route on; the router falls back to cheapest). */
export const MIN_RUNS_FOR_VALUE = 3;

/**
 * Learned VALUE score per model (model id -> number, higher is better), for the
 * router's value-aware selection. Value = "ready output per dollar", nudged by
 * first-pass rate (a model that needs fewer repair attempts is worth more at the
 * same readyRate). Only scores models with enough data AND a known price - an
 * under-sampled or unpriced model is OMITTED (the router then treats it as
 * unscored and falls back to cheapest), so a $0-recorded Foundry model never reads
 * as "infinite value". Pure.
 *
 * Optional `taskClasses`: when the pending task stresses specific limitation
 * classes (e.g. ["broken-imports"] for an import-heavy multi-file build), the
 * score is discounted by the model's failure rate in THOSE classes, so a model
 * weak where this task is hard scores lower even if generally strong. The
 * class->failure mapping is the one defined in fromModelGrade (no second copy).
 * Empty/omitted taskClasses => the original overall value (backward compatible).
 */
export function modelValueScores(
  perModel: readonly ModelGrade[],
  minRuns: number = MIN_RUNS_FOR_VALUE,
  taskClasses: readonly string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of perModel) {
    if (m.n < minRuns) continue; // too little data to trust
    if (m.pricedShare <= 0 || m.avgCostUsd <= 0) continue; // unpriced -> value-per-dollar is undefined
    const classDiscount = taskClasses.length
      ? 1 - Math.max(0, ...taskClasses.map((k) => fromModelGrade(m).classRate[k] ?? 0))
      : 1;
    out[m.model] = (m.readyRate * (0.5 + 0.5 * m.firstPassRate) * classDiscount) / m.avgCostUsd;
  }
  return out;
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

