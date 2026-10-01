/**
 * Grading + drift for the factory itself.
 *
 * The pipeline records a run per change; this scores those runs so we can answer
 * "is the factory accurate, and is any model drifting?" - the measurement that
 * turns a governed pipeline into a self-improving one. Pure over a list of run
 * records, so it is testable without a database; a thin adapter maps the recorded
 * ai_code.pipeline_run events into these records.
 *
 * Definitions kept deliberate:
 *  - readyRate: fraction of runs that reached ready_for_pr (the gate allowed).
 *  - firstPassRate: reached ready_for_pr with ZERO repair attempts (the executor
 *    got it right first time) - the sharpest quality signal.
 *  - drift: a model whose readyRate in the RECENT window dropped materially vs its
 *    PRIOR window, with enough samples in each to be real, not noise.
 */

export interface PipelineRunRecord {
  /** The executor model that authored the change. */
  model: string;
  status: "ready_for_pr" | "needs_human";
  /** Repair attempts (0 = first-pass). */
  attempts: number;
  finalOutcome: "allow" | "escalate" | "block";
  deepScanCritical?: number;
  /** The author retry recovered a fixable mistake given the exact feedback. */
  selfHealed?: boolean;
  /** USD cost of the run. */
  costUsd?: number;
  /** Which deterministic gate the FINAL draft tripped (counts; 0 = clean). The
   *  model's failure fingerprint, the raw material for a capability profile. */
  phantomImports?: number;
  brokenLocalImports?: number;
  incompleteFiles?: number;
  removedExports?: number;
  anchorFailures?: number;
  /** Ordering key (epoch ms). Optional; array order is used when absent. */
  ts?: number;
}

/** Fraction of a model's runs that tripped each deterministic gate. A model's
 *  "where does it fail" signature - a cheap model might trip broken-local-import
 *  often while a strong one trips nothing. */
export interface FailureProfile {
  phantomImports: number;
  brokenLocalImports: number;
  incompleteFiles: number;
  removedExports: number;
  anchorFailures: number;
  deepScanCritical: number;
}

export interface GradeMetrics {
  n: number;
  readyRate: number;
  firstPassRate: number;
  blockRate: number;
  /** Of the runs a model got into trouble on (self-healed OR needs_human), the
   *  fraction feedback rescued. "When it errs, can it recover?" - the signal that
   *  separates a usable-with-guardrails model from one that cannot be nudged. */
  recoveryRate: number;
  /** Mean USD per run - value-per-dollar when read next to readyRate. */
  avgCostUsd: number;
  failureProfile: FailureProfile;
}

export interface ModelGrade extends GradeMetrics {
  model: string;
}

export interface Grade extends GradeMetrics {
  total: number;
  escalationRate: number;
  byModel: ModelGrade[];
}

const rate = (num: number, denom: number): number => (denom === 0 ? 0 : num / denom);

function gradeSet(records: readonly PipelineRunRecord[]): GradeMetrics {
  const n = records.length;
  const ready = records.filter((r) => r.status === "ready_for_pr").length;
  const firstPass = records.filter((r) => r.status === "ready_for_pr" && r.attempts === 0).length;
  const blocked = records.filter((r) => r.finalOutcome === "block").length;
  const selfHealed = records.filter((r) => r.selfHealed === true).length;
  const needsHuman = records.filter((r) => r.status === "needs_human").length;
  const totalCost = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const incidence = (pred: (r: PipelineRunRecord) => boolean) => rate(records.filter(pred).length, n);
  return {
    n,
    readyRate: rate(ready, n),
    firstPassRate: rate(firstPass, n),
    blockRate: rate(blocked, n),
    // Denominator is runs that HIT trouble, not all runs: a model that rarely
    // errs but always recovers should read 1.0, not be diluted by its clean runs.
    recoveryRate: rate(selfHealed, selfHealed + needsHuman),
    avgCostUsd: rate(totalCost, n),
    failureProfile: {
      phantomImports: incidence((r) => (r.phantomImports ?? 0) > 0),
      brokenLocalImports: incidence((r) => (r.brokenLocalImports ?? 0) > 0),
      incompleteFiles: incidence((r) => (r.incompleteFiles ?? 0) > 0),
      removedExports: incidence((r) => (r.removedExports ?? 0) > 0),
      anchorFailures: incidence((r) => (r.anchorFailures ?? 0) > 0),
      deepScanCritical: incidence((r) => (r.deepScanCritical ?? 0) > 0),
    },
  };
}

/** Overall + per-model grades. */
export function gradeRuns(records: readonly PipelineRunRecord[]): Grade {
  const total = records.length;
  const escalated = records.filter((r) => r.attempts > 0 || r.status === "needs_human").length;
  const byModelMap = new Map<string, PipelineRunRecord[]>();
  for (const r of records) {
    const list = byModelMap.get(r.model) ?? [];
    list.push(r);
    byModelMap.set(r.model, list);
  }
  const base = gradeSet(records);
  const byModel: ModelGrade[] = [...byModelMap.entries()]
    .map(([model, rs]) => ({ model, ...gradeSet(rs) }))
    .sort((a, b) => b.n - a.n);
  return {
    ...base,
    total,
    escalationRate: rate(escalated, total),
    byModel,
  };
}

export interface DriftFlag {
  model: string;
  priorReadyRate: number;
  recentReadyRate: number;
  drop: number;
  priorN: number;
  recentN: number;
}

export interface DriftOptions {
  /** Minimum runs in EACH window for the comparison to be trusted. */
  minSamples?: number;
  /** readyRate drop (prior - recent) at/above which drift is flagged. */
  dropThreshold?: number;
}

/**
 * Per-model drift: split each model's runs (chronologically) in half and flag a
 * material readyRate drop in the recent half. Requires enough samples in both
 * halves so a bad afternoon does not read as drift.
 */
export function detectDrift(records: readonly PipelineRunRecord[], opts: DriftOptions = {}): DriftFlag[] {
  const minSamples = opts.minSamples ?? 5;
  const dropThreshold = opts.dropThreshold ?? 0.2;

  const byModel = new Map<string, PipelineRunRecord[]>();
  for (const r of records) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const flags: DriftFlag[] = [];
  for (const [model, rs] of byModel) {
    const sorted = [...rs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const mid = Math.floor(sorted.length / 2);
    const prior = sorted.slice(0, mid);
    const recent = sorted.slice(mid);
    if (prior.length < minSamples || recent.length < minSamples) continue;
    const priorReadyRate = gradeSet(prior).readyRate;
    const recentReadyRate = gradeSet(recent).readyRate;
    const drop = priorReadyRate - recentReadyRate;
    if (drop >= dropThreshold) {
      flags.push({ model, priorReadyRate, recentReadyRate, drop, priorN: prior.length, recentN: recent.length });
    }
  }
  return flags.sort((a, b) => b.drop - a.drop);
}
