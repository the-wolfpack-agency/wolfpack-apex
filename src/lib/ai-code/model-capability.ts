/**
 * EMPIRICAL model capability - the moat. The model registry assigns each model a
 * capabilityTier ("small" | "large" | "reasoning") from the vendor's marketing.
 * This module measures what the model ACTUALLY does in our pipeline, using the
 * deterministic gate's verdicts as free ground-truth labels (see
 * modelLimitationProfiles in benchmark-score.ts), and turns that into two things
 * nobody else has the data to build:
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

/** Measure one model's observed capability from its limitation profile. Pure. */
export function observedCapability(p: ModelLimitationProfile): ObservedCapability {
  const sample = p.authoringTasks;
  // each withheld authoring task contributes exactly one reason, so the count
  // sum is the number of authoring tasks the gate had to withhold.
  const withheld = sum(Object.values(p.limitations).map((l) => l.count));
  const limitationRate = sample > 0 ? withheld / sample : 0;
  const observedTier: ObservedTier =
    sample === 0 ? "mid" : limitationRate <= HIGH_BAR ? "large" : limitationRate >= LOW_BAR ? "small" : "mid";
  return {
    model: p.model,
    limitationRate,
    firstPassRate: p.firstPassRate,
    sample,
    observedTier,
    confident: sample >= MIN_SAMPLE,
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
export function capabilityMismatch(declaredTier: DeclaredTier, p: ModelLimitationProfile): CapabilityMismatch {
  const obs = observedCapability(p);
  const base = { model: p.model, declaredTier, observedTier: obs.observedTier, limitationRate: obs.limitationRate, sample: obs.sample };
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
  profiles: readonly ModelLimitationProfile[],
  opts: { maxClassRate?: number } = {},
): RouteAdvice {
  const maxClassRate = opts.maxClassRate ?? DEFAULT_MAX_CLASS_RATE;
  const byModel = new Map(profiles.map((p) => [p.model, p]));

  const considered: RouteConsideration[] = candidates.map((c) => {
    const p = byModel.get(c.model);
    const obs = p ? observedCapability(p) : null;
    const worstClassRate = p
      ? Math.max(0, ...taskClasses.map((k) => p.limitations[k]?.rate ?? 0))
      : 0;
    const proven = !!obs && obs.confident;
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
