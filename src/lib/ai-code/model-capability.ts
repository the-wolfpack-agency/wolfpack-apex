/**
 * EMPIRICAL model capability - the moat. The model registry assigns each model a
 * capabilityTier ("small" | "large" | "reasoning") from the vendor's marketing.
 * This module measures what the model ACTUALLY does in our pipeline, using the
 * deterministic gate's verdicts as free ground-truth labels. It consumes a
 * normalized CapabilitySource that BOTH the live per-model grade (grading.ts
 * ModelGrade, aggregated from real ai_code.pipeline_run events - the real-usage
 * flywheel) and the synthetic benchmark (benchmark-score.ts) adapt into, so the
 * decision logic is one implementation over either source. It turns that into two
 * things nobody else has the data to build:
 *
 *   1. DECLARED vs OBSERVED capability - does a model perform at the weight class
 *      it is tagged? ("tagged large, but a 45% import-limitation rate" = punches
 *      below its class on import-heavy work.)
 *   2. Cost-efficient routing ADVICE - for a task that stresses a given set of
 *      limitation classes, the cheapest model whose observed rate for those
 *      classes is acceptable. Spend a big model only where a small one measurably
 *      fails.
 *
 * Pure + decoupled from the registry: the caller (the live router, a later step)
 * supplies the candidates + their cost rank and reads the returned model, so this
 * decision logic is unit-testable without the whole model stack.
 */
import type { ModelLimitationProfile } from "./benchmark-score";
import type { ModelGrade } from "./grading";

/** Vendor/registry-declared tier. Mirrors CapabilityTier in ai/models/types.ts. */
export type DeclaredTier = "small" | "large" | "reasoning";

/** Empirical bucket derived from measured failure (distinct from the declared tier). */
export type ObservedTier = "small" | "mid" | "large";

/** Below this many observed authoring tasks, a read is provisional, not trusted. */
export const MIN_SAMPLE = 5;
/** limitationRate <= this -> observed "large"; >= LOW_BAR -> observed "small". */
export const HIGH_BAR = 0.15;
export const LOW_BAR = 0.45;
/** Default per-class ceiling a candidate must clear to be routed a stressing task. */
export const DEFAULT_MAX_CLASS_RATE = 0.3;

/** A model's observed capability, measured from gate-labeled outcomes. */
export interface ObservedCapability {
  model: string;
  /** withheld-authoring tasks / authoring tasks (0 = never withheld; lower = more capable). */
  limitationRate: number;
  firstPassRate: number;
  /** authoring tasks observed - the sample size behind the read. */
  sample: number;
  observedTier: ObservedTier;
  /** sample >= MIN_SAMPLE. A provisional read should not override a declared tier. */
  confident: boolean;
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/**
 * Normalized capability observation. BOTH sources adapt into this, so one
 * capability core serves the live pipeline grades (grading.ts ModelGrade, the
 * real-usage flywheel) AND the synthetic benchmark (ModelLimitationProfile) - no
 * second capability implementation per source.
 */
export interface CapabilitySource {
  model: string;
  /** authoring runs observed - the sample behind the read. */
  sample: number;
  /** fraction of authoring runs the gate had to withhold (0..1). lower = more capable. */
  limitationRate: number;
  firstPassRate: number;
  /** per-limitation-class incidence (fraction of runs tripping that class). */
  classRate: Record<string, number>;
}

/**
 * Adapt a LIVE per-model grade (grading.ts, from real ai_code.pipeline_run events)
 * into a CapabilitySource. The gate withheld any run that did not reach
 * ready_for_pr, so limitationRate = 1 - readyRate; per-class rates come from the
 * failure profile (incidence per deterministic gate). This is the real-usage path.
 */
export function fromModelGrade(g: ModelGrade): CapabilitySource {
  const fp = g.failureProfile;
  return {
    model: g.model,
    sample: g.n,
    limitationRate: Math.max(0, 1 - g.readyRate),
    firstPassRate: g.firstPassRate,
    classRate: {
      "broken-imports": fp.brokenLocalImports,
      "phantom-imports": fp.phantomImports,
      "incomplete-files": fp.incompleteFiles,
      "removed-exports": fp.removedExports,
      "anchor-failure": fp.anchorFailures,
      security: fp.deepScanCritical,
    },
  };
}

/**
 * Adapt a benchmark limitation profile into a CapabilitySource. Each withheld
 * authoring task contributes exactly one reason, so the count sum is the number
 * of withheld tasks.
 */
export function fromLimitationProfile(p: ModelLimitationProfile): CapabilitySource {
  const withheld = sum(Object.values(p.limitations).map((l) => l.count));
  const classRate: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.limitations)) classRate[k] = v.rate;
  return {
    model: p.model,
    sample: p.authoringTasks,
    limitationRate: p.authoringTasks > 0 ? withheld / p.authoringTasks : 0,
    firstPassRate: p.firstPassRate,
    classRate,
  };
}

/** Measure one model's observed capability from a normalized source. Pure. */
export function observedCapability(s: CapabilitySource): ObservedCapability {
  const observedTier: ObservedTier =
    s.sample === 0 ? "mid" : s.limitationRate <= HIGH_BAR ? "large" : s.limitationRate >= LOW_BAR ? "small" : "mid";
  return {
    model: s.model,
    limitationRate: s.limitationRate,
    firstPassRate: s.firstPassRate,
    sample: s.sample,
    observedTier,
    confident: s.sample >= MIN_SAMPLE,
  };
}

/** Declared vs observed - does the model perform at the weight class it is tagged? */
export interface CapabilityMismatch {
  model: string;
  declaredTier: DeclaredTier;
  observedTier: ObservedTier;
  /** matches | below (performs worse than declared) | above (punches up). */
  verdict: "matches" | "below" | "above" | "unproven";
  limitationRate: number;
  sample: number;
}

/** Collapse the declared tier onto the observed scale for comparison. */
function declaredAsObserved(t: DeclaredTier): ObservedTier {
  return t === "small" ? "small" : "large"; // "large" and "reasoning" both expect strong SDLC output
}

const RANK: Record<ObservedTier, number> = { small: 0, mid: 1, large: 2 };

/** Compare a model's declared tier to its measured capability. Pure. */
export function capabilityMismatch(declaredTier: DeclaredTier, s: CapabilitySource): CapabilityMismatch {
  const obs = observedCapability(s);
  const base = { model: s.model, declaredTier, observedTier: obs.observedTier, limitationRate: obs.limitationRate, sample: obs.sample };
  if (!obs.confident) return { ...base, verdict: "unproven" };
  const expected = RANK[declaredAsObserved(declaredTier)];
  const got = RANK[obs.observedTier];
  const verdict = got === expected ? "matches" : got < expected ? "below" : "above";
  return { ...base, verdict };
}

/** A routing candidate: caller supplies the cost rank (lower = cheaper). */
export interface RouteCandidate {
  model: string;
  /** relative cost; lower is cheaper. Caller derives it from the model registry. */
  costRank: number;
}

export interface RouteConsideration {
  model: string;
  costRank: number;
  /** worst observed limitation rate across the task's stressed classes. */
  worstClassRate: number;
  /** has a confident profile AND clears the ceiling for every stressed class. */
  cleared: boolean;
  proven: boolean;
}

export interface RouteAdvice {
  model: string | null;
  reason: string;
  considered: RouteConsideration[];
}

/**
 * Advisory: the CHEAPEST candidate whose observed limitation rate for every class
 * the task stresses is at or below maxClassRate (and whose read is confident).
 * Falls back to the most capable proven candidate, then to the cheapest overall
 * when there is no telemetry yet. Pure; the live router reads `.model`.
 */
export function recommendModel(
  taskClasses: readonly string[],
  candidates: readonly RouteCandidate[],
  sources: readonly CapabilitySource[],
  opts: { maxClassRate?: number } = {},
): RouteAdvice {
  const maxClassRate = opts.maxClassRate ?? DEFAULT_MAX_CLASS_RATE;
  const byModel = new Map(sources.map((s) => [s.model, s]));

  const considered: RouteConsideration[] = candidates.map((c) => {
    const s = byModel.get(c.model);
    const worstClassRate = s
      ? Math.max(0, ...taskClasses.map((k) => s.classRate[k] ?? 0))
      : 0;
    const proven = !!s && s.sample >= MIN_SAMPLE;
    const cleared = proven && worstClassRate <= maxClassRate;
    return { model: c.model, costRank: c.costRank, worstClassRate, cleared, proven };
  });

  const byCost = [...candidates].sort((a, b) => a.costRank - b.costRank);
  const consById = new Map(considered.map((c) => [c.model, c]));

  // 1. cheapest proven-clearing candidate.
  const cleared = byCost.find((c) => consById.get(c.model)?.cleared);
  if (cleared) {
    const w = Math.round((consById.get(cleared.model)!.worstClassRate) * 100);
    return { model: cleared.model, reason: `cheapest model clearing ${taskClasses.join("+") || "the task"} (worst class ${w}% <= ${Math.round(maxClassRate * 100)}%)`, considered };
  }
  // 2. no cheap model clears -> the most capable PROVEN candidate (lowest worst-class rate).
  const proven = considered.filter((c) => c.proven).sort((a, b) => a.worstClassRate - b.worstClassRate);
  if (proven.length > 0) {
    return { model: proven[0].model, reason: `no cheaper model clears ${taskClasses.join("+") || "the task"}; routing to the most capable proven model`, considered };
  }
  // 3. no telemetry at all -> cheapest overall, flagged as unproven.
  if (byCost.length > 0) {
    return { model: byCost[0].model, reason: "no limitation telemetry yet; defaulting to the cheapest candidate", considered };
  }
  return { model: null, reason: "no candidates", considered };
}
