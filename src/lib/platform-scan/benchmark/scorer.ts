/**
 * Benchmark scorer + active-learning signal extraction.
 *
 * This is the ML-grade evaluation engine: it takes scan findings produced
 * against the consent-to-test corpus (self-hosted vulnerable apps + our own
 * surfaces, see `corpus.ts`) and scores them against per-target GROUND TRUTH,
 * then mines two kinds of concrete "improve the tool" signals:
 *
 *   - coverage_gap   : a labeled finding class we FAILED to detect. A detector
 *                      to build or fix. This is the "find what we do not cover"
 *                      half of the mandate.
 *   - noise_candidate: a class we report FREQUENTLY across labeled targets that
 *                      appears in NO ground truth. A precision-tune candidate -
 *                      the 74->2 discipline systematized.
 *
 * PRECISION/RECALL HONESTY CAVEAT (the precision-first ethos):
 *   Precision and recall are ONLY trustworthy on LABELED targets (targets with
 *   a non-empty `groundTruth`). On an unlabeled target we cannot know what we
 *   missed (recall is meaningless) and we cannot know whether an "extra" class
 *   is a false positive or a real finding the labels simply do not list yet.
 *   We therefore represent an unknowable metric as `null` (NOT 1) - an explicit
 *   "not applicable" the dashboard renders as "n/a", never as "100%". A vacuous
 *   1 shown to a client is a LIE; null is the truth. Every aggregate metric here
 *   is computed OVER LABELED TARGETS ONLY, and every "extra" class is surfaced
 *   as a *candidate*, never a confirmed false positive. Ground truth may be
 *   incomplete; we never punish the tool for finding a true bug that the corpus
 *   has not yet labeled.
 *
 * Everything here is PURE: no DB, no network, no clock. The only side effect is
 * analytics emission, and `trackEvent` is INJECTED (deps) so tests are fully
 * deterministic and no data is lost to the learning loop. No data lost: every
 * signal mined is emitted, every benchmark run is recorded.
 */

import { trackEvent } from "@/lib/analytics";
import type { ScanFinding } from "../types";
import type { BenchmarkTarget } from "./corpus";

/**
 * Stable class key for a finding: `${category}:${title}`. This mirrors the
 * natural-key dedupe used by the store (route+title identity) but drops the
 * route, because a finding CLASS is what a detector covers, independent of
 * which route it fired on. `groundTruth.findingClass` uses this same form.
 */
export function findingClassKey(finding: Pick<ScanFinding, "category" | "title">): string {
  return `${finding.category}:${finding.title}`;
}

/** Per-target scoring result. */
export interface TargetScore {
  name: string;
  /** Ground-truth classes we DID find (true positives). */
  matched: string[];
  /** Ground-truth classes we MISSED = coverage gaps (recall misses). */
  missed: string[];
  /**
   * Classes we reported that are NOT in ground truth = potential noise / false
   * positives. ONLY meaningful for fully-labeled targets; for an unlabeled
   * target these are still listed (so no data is lost) but `labeled` is false,
   * flagging them as untrustworthy (ground truth may simply be incomplete).
   * A class here is a CANDIDATE, never a confirmed false positive.
   */
  extra: { findingClass: string; count: number }[];
  /**
   * matched / groundTruth.length. `null` when no ground truth is defined - there
   * is nothing to measure recall against, so recall is NOT APPLICABLE (the
   * dashboard must render "n/a", never "100%"). Only a real number on a labeled
   * target; see `labeled`.
   */
  recall: number | null;
  /** Whether the target has ground truth. Precision/recall are only trustworthy when true. */
  labeled: boolean;
}

/** Aggregate report across the whole benchmark run. */
export interface BenchmarkReport {
  /** Number of targets evaluated (including errored ones). */
  targets: number;
  /** Per-target scores, in input order. */
  perTarget: TargetScore[];
  /**
   * Overall recall over LABELED targets only: sum(matched) / sum(groundTruth).
   * `null` when there are no labeled targets - recall is NOT APPLICABLE (render
   * "n/a", never "100%"). A real number only when `labeledTargets > 0`.
   */
  recall: number | null;
  /**
   * Precision-ish over LABELED targets only: sum(matched) / sum(matched+extra).
   * "ish" because extras are candidates, not confirmed false positives. `null`
   * when nothing is reported on labeled targets (NOT APPLICABLE, render "n/a").
   * A real number only when there is something to score.
   */
  precision: number | null;
  /** Distinct finding classes seen across ALL targets (labeled or not). Coverage breadth. */
  coverageClasses: string[];
  /** Targets that errored (could not be scanned) - a robustness signal. */
  erroredCount: number;
  /** How many targets carried ground truth. Metrics above are only trusted when > 0. */
  labeledTargets: number;
}

/** A mined active-learning signal: an input that makes the tool improve. */
export interface LearningSignal {
  kind: "coverage_gap" | "noise_candidate";
  findingClass: string;
  detail: string;
}

/** One scanned target's input to the benchmark. */
export interface BenchmarkResult {
  target: BenchmarkTarget;
  findings: ScanFinding[];
  /** True when the scan could not run / errored (robustness accounting). */
  errored?: boolean;
}

/** Injected dependencies. trackEvent defaults to the real emitter. */
export interface ScorerDeps {
  trackEvent: typeof trackEvent;
  /** Actor attributed to emitted events. Defaults to an unattended "system" actor
   *  so benchmark/learning data still reaches the loop for canary/sweep runs. */
  actor: { id: string; role: string };
}

export const defaultScorerDeps: ScorerDeps = {
  trackEvent,
  actor: { id: "system", role: "system" },
};

/**
 * Threshold at which an unlabeled (relative to ground truth) class becomes a
 * noise candidate. A class firing this many times or more across labeled
 * targets, while present in NO ground truth, is flagged for precision tuning.
 */
export const NOISE_CANDIDATE_MIN_COUNT = 3;

// ---------------------------------------------------------------------------
// 1. scoreTarget - pure per-target scoring
// ---------------------------------------------------------------------------

/**
 * Score one target's findings against its ground truth.
 *
 * Maps every finding to its class key, compares the set against the target's
 * declared ground-truth classes, and partitions into matched / missed / extra.
 * On an unlabeled target nothing can be "missed" (recall is `null` = NOT
 * APPLICABLE, never a vacuous 1) and every reported class lands in `extra` but
 * flagged untrustworthy via `labeled: false`.
 */
export function scoreTarget(target: BenchmarkTarget, findings: ScanFinding[]): TargetScore {
  const groundTruth = target.groundTruth ?? [];
  const labeled = groundTruth.length > 0;
  const truthClasses = new Set(groundTruth.map((g) => g.findingClass));

  // Count reported classes (a class can fire on several routes).
  const reportedCounts = new Map<string, number>();
  for (const f of findings) {
    const key = findingClassKey(f);
    reportedCounts.set(key, (reportedCounts.get(key) ?? 0) + 1);
  }
  const reportedClasses = new Set(reportedCounts.keys());

  const matched: string[] = [];
  const missed: string[] = [];
  for (const cls of truthClasses) {
    if (reportedClasses.has(cls)) matched.push(cls);
    else missed.push(cls);
  }

  // Extra = reported classes not in ground truth. Stable-sorted for determinism.
  const extra = [...reportedCounts.entries()]
    .filter(([cls]) => !truthClasses.has(cls))
    .map(([findingClass, count]) => ({ findingClass, count }))
    .sort((a, b) => (b.count - a.count) || a.findingClass.localeCompare(b.findingClass));

  // recall = matched / groundTruth; null (NOT APPLICABLE) when there is no
  // ground truth to measure against - never a vacuous 1 that reads as "100%".
  const recall = labeled ? matched.length / groundTruth.length : null;

  return {
    name: target.name,
    matched: matched.sort(),
    missed: missed.sort(),
    extra,
    recall,
    labeled,
  };
}

// ---------------------------------------------------------------------------
// 2. scoreBenchmark - aggregate + emit platform.benchmark_run
// ---------------------------------------------------------------------------

/**
 * Aggregate a whole benchmark run.
 *
 * Errored targets are counted (robustness) but contribute no findings. Overall
 * recall and precision are computed OVER LABELED TARGETS ONLY (the honesty
 * caveat); coverageClasses is the union of distinct classes across ALL targets.
 * Fires `platform.benchmark_run` exactly once with the aggregate shape.
 */
export function scoreBenchmark(
  results: BenchmarkResult[],
  deps: ScorerDeps = defaultScorerDeps,
): BenchmarkReport {
  const perTarget: TargetScore[] = [];
  const coverage = new Set<string>();

  let erroredCount = 0;
  let labeledTargets = 0;
  let truthTotal = 0; // denominator of recall (labeled only)
  let matchedTotal = 0; // numerator of recall AND precision (labeled only)
  let extraTotalLabeled = 0; // extras on labeled targets (precision denominator part)

  for (const result of results) {
    if (result.errored) erroredCount += 1;

    // Coverage spans every class we reported anywhere, errored or not.
    for (const f of result.findings) coverage.add(findingClassKey(f));

    const score = scoreTarget(result.target, result.findings);
    perTarget.push(score);

    if (score.labeled) {
      labeledTargets += 1;
      truthTotal += score.matched.length + score.missed.length;
      matchedTotal += score.matched.length;
      extraTotalLabeled += score.extra.reduce((sum, e) => sum + e.count, 0);
    }
  }

  // Labeled-only metrics. `null` (NOT APPLICABLE) when there is nothing to score
  // (no labeled ground truth / no reports) - never a vacuous 1 that the
  // dashboard would render as "100%". A real number only when a denominator exists.
  const recall = truthTotal > 0 ? matchedTotal / truthTotal : null;
  const precisionDenom = matchedTotal + extraTotalLabeled;
  const precision = precisionDenom > 0 ? matchedTotal / precisionDenom : null;

  const coverageClasses = [...coverage].sort();

  const report: BenchmarkReport = {
    targets: results.length,
    perTarget,
    recall,
    precision,
    coverageClasses,
    erroredCount,
    labeledTargets,
  };

  deps.trackEvent("platform.benchmark_run", deps.actor.id, deps.actor.role, {
    targets: report.targets,
    // Analytics meta is string|number|boolean; a not-applicable metric is emitted
    // as the explicit string "n/a" (never coerced to 0/1 which would read as real).
    recall: report.recall ?? "n/a",
    precision: report.precision ?? "n/a",
    coverage_classes: report.coverageClasses.length,
    errored: report.erroredCount,
  });

  return report;
}

// ---------------------------------------------------------------------------
// 3. extractLearningSignals - mine + emit platform.learning_signal_detected
// ---------------------------------------------------------------------------

/**
 * Mine concrete "improve the tool" signals from a scored benchmark:
 *
 *   - one `coverage_gap` per distinct missed ground-truth class (a detector to
 *     build/fix). These come ONLY from labeled targets, since a miss is only
 *     knowable against ground truth.
 *   - one `noise_candidate` per class whose TOTAL count across LABELED targets
 *     is >= NOISE_CANDIDATE_MIN_COUNT and which appears in NO ground truth (a
 *     precision-tune candidate). Restricted to labeled targets because only
 *     there can we assert the class is genuinely outside truth; on unlabeled
 *     targets an "extra" might be a real, simply-unlabeled finding.
 *
 * No data lost: every signal is emitted via the injected trackEvent. Returns
 * the signals (stable-sorted) so callers can persist/act on them too.
 */
export function extractLearningSignals(
  report: BenchmarkReport,
  deps: ScorerDeps = defaultScorerDeps,
): LearningSignal[] {
  const signals: LearningSignal[] = [];

  // --- coverage gaps: distinct missed classes across labeled targets ---
  const gapTargets = new Map<string, string[]>(); // class -> target names that missed it
  for (const t of report.perTarget) {
    if (!t.labeled) continue;
    for (const cls of t.missed) {
      const arr = gapTargets.get(cls) ?? [];
      arr.push(t.name);
      gapTargets.set(cls, arr);
    }
  }
  for (const [findingClass, names] of [...gapTargets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    signals.push({
      kind: "coverage_gap",
      findingClass,
      detail:
        `Ground-truth class not detected on ${names.length} labeled target` +
        `${names.length === 1 ? "" : "s"} (${names.sort().join(", ")}). ` +
        `Build or fix a detector for this class.`,
    });
  }

  // --- noise candidates: high-frequency classes outside ground truth, labeled only ---
  const extraCounts = new Map<string, number>();
  for (const t of report.perTarget) {
    if (!t.labeled) continue;
    for (const e of t.extra) {
      extraCounts.set(e.findingClass, (extraCounts.get(e.findingClass) ?? 0) + e.count);
    }
  }
  for (const [findingClass, count] of [...extraCounts.entries()].sort((a, b) =>
    (b[1] - a[1]) || a[0].localeCompare(b[0]),
  )) {
    if (count < NOISE_CANDIDATE_MIN_COUNT) continue;
    signals.push({
      kind: "noise_candidate",
      findingClass,
      detail:
        `Reported ${count} times across labeled targets but in NO ground truth. ` +
        `Candidate for precision tuning (verify it is not a genuinely unlabeled finding first).`,
    });
  }

  for (const signal of signals) {
    deps.trackEvent("platform.learning_signal_detected", deps.actor.id, deps.actor.role, {
      kind: signal.kind,
      finding_class: signal.findingClass,
      detail: signal.detail,
    });
  }

  return signals;
}
