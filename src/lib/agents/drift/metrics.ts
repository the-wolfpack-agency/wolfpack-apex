/**
 * Behavioral metrics for an agent, computed from its OGIAM decisions.
 *
 * Each decision the agent's actions produced carries an outcome, a risk tier,
 * and the tool. The distribution of these over a window is the agent's behavior
 * fingerprint; drift detection compares a recent fingerprint to a baseline one.
 * Pure: takes decision rows, returns the metrics, so it is deterministic and
 * unit testable.
 */

export interface DecisionSample {
  tool: string;
  riskTier: string; // low | medium | high | critical
  intendedOutcome: string; // allow | deny | transform | escalate
  wouldBlock: boolean;
}

export interface BehaviorMetrics {
  count: number;
  /** Fraction of actions the gate would block (deny or escalate). */
  blockRate: number;
  /** Proportion of actions in each risk tier (sums to 1 when count > 0). */
  tierDist: Record<string, number>;
  /** Proportion of actions per intended outcome. */
  outcomeDist: Record<string, number>;
  /** Proportion of actions per tool. */
  toolDist: Record<string, number>;
}

function distribution(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const total = values.length;
  if (total === 0) return {};
  const out: Record<string, number> = {};
  for (const [k, c] of Object.entries(counts)) out[k] = c / total;
  return out;
}

export function computeBehaviorMetrics(samples: DecisionSample[]): BehaviorMetrics {
  const count = samples.length;
  const blocked = samples.filter((s) => s.wouldBlock).length;
  return {
    count,
    blockRate: count === 0 ? 0 : blocked / count,
    tierDist: distribution(samples.map((s) => s.riskTier)),
    outcomeDist: distribution(samples.map((s) => s.intendedOutcome)),
    toolDist: distribution(samples.map((s) => s.tool)),
  };
}

/**
 * Total variation distance between two distributions over the union of keys.
 * 0 = identical, 1 = disjoint. Symmetric and bounded, so it reads as a clean
 * "how different" score.
 */
export function totalVariationDistance(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum / 2;
}
