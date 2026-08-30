/**
 * Does the gist actually predict the outcome?
 *
 * THE QUESTION THIS ANSWERS, AND WHY IT COMES FIRST. The proposal is to learn
 * across client engagements from the shape of decisions rather than their
 * content, storing that shape in a graph so the product compounds. The graph
 * is the expensive half and the interesting claim is upstream of it: does an
 * abstraction that keeps no private data keep enough signal to be worth
 * learning from?
 *
 * If a gist-level feature predicts that a turn will go badly, the thesis holds
 * and the store is worth building. If it does not, no schema rescues it, and
 * finding that out costs a script rather than a production dependency.
 *
 * NO MODEL, NO LIBRARY, ON PURPOSE. This reports lift per feature value:
 * how often the bad outcome happens when a feature is present against the base
 * rate. A fitted model would produce a better number and a worse answer,
 * because the decision here is "is there signal at all", and an interpretable
 * per-feature answer says WHERE the signal is. It also adds no dependency,
 * which the engineering directive asks for and which matters more for
 * something that may end up running per client.
 *
 * THE FLOOR MATTERS MORE THAN THE LIFT. With 400 misses in 12,000
 * conversations, a rare feature will show enormous lift on four observations
 * and mean nothing. Anything below MIN_OBSERVATIONS is reported as
 * "not enough evidence" rather than as a finding, the same rule the retrieval
 * eval uses and for the same reason: this codebase has already adopted a
 * conclusion from six data points once and had to reverse it.
 */

import type { TurnGist } from "./features";

/** Below this a lift is noise wearing a percentage sign. */
export const MIN_OBSERVATIONS = 30;

export interface FeatureSignal {
  feature: string;
  value: string;
  /** Turns where this feature took this value. */
  observations: number;
  /** Share of those that ended badly. */
  badRate: number;
  /** badRate divided by the overall bad rate. Above 1 predicts trouble. */
  lift: number;
  /** False when there are too few observations to say anything. */
  trustworthy: boolean;
}

export interface SignalReport {
  turns: number;
  /** Overall share of turns that ended badly, the baseline everything is read against. */
  baseBadRate: number;
  /** Every feature value, worst first, so the useful ones are at the top. */
  signals: FeatureSignal[];
  /** Signals that clear the floor AND move the rate meaningfully. */
  usable: FeatureSignal[];
}

/**
 * A turn "ended badly" when the person did not get what they came for.
 *
 * single_turn is DELIBERATELY NOT counted as bad. 99.4% of conversations are
 * one question, and it means either somebody got what they needed or they gave
 * up. Calling it a failure would make the base rate 99% and every lift
 * meaningless; calling it a success would be the flattering half of an
 * ambiguity. It is excluded from the label and kept in the population.
 */
export function endedBadly(g: TurnGist): boolean {
  /* asked_which is NOT bad, and saying so is the point of having it.
     The product declining to guess between several documents is the correct
     answer to a question with no subject, and it replaced a confident wrong
     one. Counting it as a failure would teach every downstream measure to
     prefer the behaviour that was just fixed. */
  /* degraded IS bad. Both it and asked_which are honest, and that is where
     the resemblance stops: asking which document is the right answer to a
     vague question; an outage is the product failing somebody who asked a
     perfectly good one. */
  return g.outcome === "dead_end" || g.outcome === "re_asked" || g.outcome === "degraded";
}

/** Which gist fields are worth testing as predictors. */
const FEATURES: Array<{ name: string; of: (g: TurnGist) => string }> = [
  { name: "shape", of: (g) => g.shape },
  { name: "origin", of: (g) => g.origin },
  { name: "answerLength", of: (g) => g.answerLength },
  { name: "questionLength", of: (g) => g.questionLength },
  { name: "hadSources", of: (g) => String(g.hadSources) },
];

/**
 * admittedMiss IS NOT A FEATURE, and the first run of this proved why.
 *
 * It scored a lift of 27.9 with a 97.5% bad rate, which looks like the
 * strongest finding on the board and is actually circular: a dead_end is
 * DEFINED as an answer that admitted a miss and was never followed up. The
 * feature and the label are the same fact wearing two names, so it was
 * predicting itself.
 *
 * Left here as a named exclusion rather than quietly deleted, because it is
 * exactly the mistake somebody adding the next feature will make. A gist field
 * that participates in the outcome definition belongs in the OUTCOME, never in
 * the predictors.
 */
export const EXCLUDED_AS_CIRCULAR = ["admittedMiss"] as const;

export function measureSignal(gists: TurnGist[]): SignalReport {
  const turns = gists.length;
  if (turns === 0) {
    return { turns: 0, baseBadRate: 0, signals: [], usable: [] };
  }

  const baseBad = gists.filter(endedBadly).length / turns;

  const signals: FeatureSignal[] = [];
  for (const feature of FEATURES) {
    const buckets = new Map<string, { n: number; bad: number }>();
    for (const g of gists) {
      const value = feature.of(g);
      const b = buckets.get(value) ?? { n: 0, bad: 0 };
      b.n += 1;
      if (endedBadly(g)) b.bad += 1;
      buckets.set(value, b);
    }
    for (const [value, b] of buckets) {
      const badRate = b.n === 0 ? 0 : b.bad / b.n;
      signals.push({
        feature: feature.name,
        value,
        observations: b.n,
        badRate,
        /* Guarded: a zero base rate would make every lift infinite, which is
           the shape of a divide-by-zero pretending to be a discovery. */
        lift: baseBad === 0 ? 0 : badRate / baseBad,
        trustworthy: b.n >= MIN_OBSERVATIONS,
      });
    }
  }

  signals.sort((a, b) => b.lift - a.lift || b.observations - a.observations);

  /* USABLE means both believable and worth acting on. A feature that shifts
     the rate by 10% is real and changes nothing anybody would do. */
  const usable = signals.filter((s) => s.trustworthy && (s.lift >= 1.5 || s.lift <= 0.5));

  return { turns, baseBadRate: baseBad, signals, usable };
}
