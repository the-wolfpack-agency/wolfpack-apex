/**
 * Drift detection: compare a recent behavior fingerprint to the baseline and
 * decide whether the agent has drifted. Pure and deterministic.
 *
 * The score is the strongest of three explainable signals: the change in block
 * rate (is the agent suddenly trying things the gate stops), and the total
 * variation distance of the risk-tier and tool distributions (is it doing a
 * different mix of things). Reporting the components, not just a number, means a
 * drift verdict is always explainable.
 */

import {
  totalVariationDistance,
  type BehaviorMetrics,
} from "./metrics";

export type DriftVerdict = "stable" | "drifting" | "critical" | "insufficient_data";

/** Minimum decisions in EACH window for a check to be meaningful. */
export const MIN_SAMPLES = 8;
/** Below this the agent is stable. */
export const WARN_THRESHOLD = 0.25;
/** At or above this the agent is auto-paused. */
export const PAUSE_THRESHOLD = 0.5;

export interface DriftComponents {
  blockRateDelta: number;
  tierDistance: number;
  toolDistance: number;
}

export interface DriftResult {
  verdict: DriftVerdict;
  score: number;
  components: DriftComponents;
  /** True when the verdict warrants auto-pausing the agent. */
  shouldPause: boolean;
}

export function computeDrift(
  baseline: BehaviorMetrics,
  recent: BehaviorMetrics,
): DriftResult {
  if (baseline.count < MIN_SAMPLES || recent.count < MIN_SAMPLES) {
    return {
      verdict: "insufficient_data",
      score: 0,
      components: { blockRateDelta: 0, tierDistance: 0, toolDistance: 0 },
      shouldPause: false,
    };
  }

  const components: DriftComponents = {
    blockRateDelta: Math.abs(recent.blockRate - baseline.blockRate),
    tierDistance: totalVariationDistance(baseline.tierDist, recent.tierDist),
    toolDistance: totalVariationDistance(baseline.toolDist, recent.toolDist),
  };
  const score = Math.max(
    components.blockRateDelta,
    components.tierDistance,
    components.toolDistance,
  );

  let verdict: DriftVerdict;
  if (score >= PAUSE_THRESHOLD) verdict = "critical";
  else if (score >= WARN_THRESHOLD) verdict = "drifting";
  else verdict = "stable";

  return { verdict, score, components, shouldPause: verdict === "critical" };
}
