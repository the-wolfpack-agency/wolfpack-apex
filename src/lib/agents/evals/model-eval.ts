/**
 * Model-version regression evaluation: given an agent's task-success rate per
 * model, decide whether the NEWEST model it ran on regressed against the model
 * it used before. Pure and deterministic (no I/O, no clock).
 *
 * This is the specific, differentiated half of "agent evals" that the codebase
 * did not have: every existing eval, baseline, and drift check compares across
 * TIME and so conflates a model bump with a prompt or data change. Here the
 * agent (and thus its task mix) is held fixed and only the model varies across
 * time, so the success-rate delta is attributable to the model switch. That is
 * the founding pain ("agents behave inconsistently across model versions") made
 * measurable.
 *
 * The verdict reports the two models, both rates, the delta, and the sample
 * sizes, so a regression is always explainable rather than a bare number.
 */

export type ModelEvalVerdict =
  | "stable"
  | "regressed"
  | "improved"
  | "insufficient_data";

/** Minimum completed tasks on EACH model for a comparison to be meaningful. */
export const MIN_SAMPLES_PER_MODEL = 5;
/**
 * A success-rate DROP (baseline - candidate) at or above this is a regression.
 * 0.15 = a 15-percentage-point fall in task success, a shift an operator should
 * see and decide whether to roll the model back.
 */
export const REGRESSION_THRESHOLD = 0.15;
/** A success-rate GAIN at or above this is a real improvement (for context). */
export const IMPROVEMENT_THRESHOLD = 0.15;

/**
 * Per-model task-outcome stats for one agent. `recencyRank` orders the models by
 * most-recent use: 0 = the newest model this agent ran on, 1 = the one before,
 * and so on.
 */
export interface ModelStats {
  model: string;
  /** All completed tasks on this model (succeeded + failed + blocked). */
  total: number;
  /** Tasks that reached the honest `succeeded` terminal state. */
  succeeded: number;
  /** succeeded / total, in [0,1]; 0 when total is 0. */
  successRate: number;
  recencyRank: number;
}

export interface ModelEvalResult {
  verdict: ModelEvalVerdict;
  /** The newest model (recencyRank 0), or null when none. */
  candidateModel: string | null;
  /** The previously-used model (recencyRank 1), or null when none. */
  baselineModel: string | null;
  candidateSuccessRate: number;
  baselineSuccessRate: number;
  /** candidate - baseline. Negative = the newer model does worse. */
  delta: number;
  candidateSamples: number;
  baselineSamples: number;
  /** True only when the verdict is a regression (drives alert + audit). */
  shouldAlert: boolean;
}

/** Success rate in [0,1]; a total of 0 yields 0 (never NaN). */
export function makeSuccessRate(succeeded: number, total: number): number {
  return total > 0 ? succeeded / total : 0;
}

function insufficient(
  candidate: ModelStats | null,
  baseline: ModelStats | null,
): ModelEvalResult {
  return {
    verdict: "insufficient_data",
    candidateModel: candidate?.model ?? null,
    baselineModel: baseline?.model ?? null,
    candidateSuccessRate: candidate?.successRate ?? 0,
    baselineSuccessRate: baseline?.successRate ?? 0,
    delta: 0,
    candidateSamples: candidate?.total ?? 0,
    baselineSamples: baseline?.total ?? 0,
    shouldAlert: false,
  };
}

/**
 * Compare the newest model against the previously-used model.
 *
 * Needs at least two distinct models, each with MIN_SAMPLES_PER_MODEL completed
 * tasks, to attribute a change to a model switch; otherwise the verdict is
 * `insufficient_data` (never a false all-clear). The input is defensively
 * re-sorted by recencyRank so callers cannot depend on query order.
 */
export function evaluateModelRegression(models: ModelStats[]): ModelEvalResult {
  const ordered = [...models].sort((a, b) => a.recencyRank - b.recencyRank);
  const candidate = ordered[0] ?? null;
  const baseline = ordered[1] ?? null;

  if (!candidate || !baseline) return insufficient(candidate, baseline);
  if (
    candidate.total < MIN_SAMPLES_PER_MODEL ||
    baseline.total < MIN_SAMPLES_PER_MODEL
  ) {
    return insufficient(candidate, baseline);
  }

  const delta = candidate.successRate - baseline.successRate;
  let verdict: ModelEvalVerdict;
  if (delta <= -REGRESSION_THRESHOLD) verdict = "regressed";
  else if (delta >= IMPROVEMENT_THRESHOLD) verdict = "improved";
  else verdict = "stable";

  return {
    verdict,
    candidateModel: candidate.model,
    baselineModel: baseline.model,
    candidateSuccessRate: candidate.successRate,
    baselineSuccessRate: baseline.successRate,
    delta,
    candidateSamples: candidate.total,
    baselineSamples: baseline.total,
    shouldAlert: verdict === "regressed",
  };
}
