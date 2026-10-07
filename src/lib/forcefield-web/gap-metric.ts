/**
 * The GAP METRIC: of the proven-hostile actions a population contains, what
 * fraction did the DETERMINISTIC gate prevent, and what slipped through? This is
 * the number that turns "deterministic tooling closes the gap" from a slogan into
 * a defensible claim: "the gate prevented 94% of hostile actions in this envelope,
 * auditably, and the 6% that slipped became rules."
 *
 * Two inputs feed the same pure scorer so the metric is computed ONE way:
 *   1. OFFLINE red-team (factory): AI generates novel attacks -> runGapCases runs
 *      them against the real engine -> scoreGap. The slip list IS the next round
 *      of rules. See scripts/forcefield-ai-redteam.ts.
 *   2. LIVE envelope (future): a reader maps stored enforcement events to the same
 *      GapOutcome shape and calls scoreGap. Same metric, real traffic.
 *
 * scoreGap is PURE arithmetic (no engine, no I/O) so it is trivially testable and
 * reusable by either source. runGapCases runs the real deterministic engine and is
 * the offline bridge. Neither touches a model: AI generates the cases in the
 * factory; the scoring and the engine stay deterministic (boundary holds).
 */
import { decideEnforcement } from "./enforce";
import { DEFAULT_RULESET, type ForcefieldRuleset } from "./ruleset";

/** A single attempted action + whether it was MEANT to be hostile. The minimal
 *  shape both the AI generator and a live-event reader can produce. */
export interface GapCase {
  name: string;
  input: {
    path: string;
    rawUrl?: string;
    method: string;
    userAgent: string;
    headerNames: string[];
  };
  /** True when this case is a genuine attack (the engine SHOULD block it). */
  intendedHostile: boolean;
}

/** A case after the gate decided: did it block? Decoupled from GapCase so a live
 *  reader can supply `blocked` from a stored event instead of re-running. */
export interface GapOutcome {
  name: string;
  intendedHostile: boolean;
  blocked: boolean;
  /** Carried through for the slip report so a gap is actionable (what to rule). */
  input?: GapCase["input"];
}

export interface GapSlip {
  name: string;
  input?: GapCase["input"];
}

export interface GapScore {
  /** Every case considered. */
  total: number;
  /** The proven-hostile subset (the denominator for the prevention rate). */
  hostile: number;
  /** Hostile AND blocked: the gap the gate closed. */
  prevented: number;
  /** prevented / hostile, as a percentage to one decimal. 100 when there is
   *  nothing hostile to miss (no gap exists). */
  preventedPct: number;
  /** Hostile AND NOT blocked: the open gap. Each one is a missing rule. */
  slipped: number;
  /** The slips, carried with their input so they can be turned into rules. */
  slips: GapSlip[];
  /** Benign AND blocked: a false positive, the worst outcome for a real user. */
  falsePositives: number;
  falsePositiveCases: string[];
}

/**
 * Score a decided population. Pure: same outcomes in, same score out. The
 * prevention rate is computed over the hostile subset only; false positives are
 * counted separately because a defense that turns real users away is worse than
 * one that misses an attacker.
 */
export function scoreGap(outcomes: readonly GapOutcome[]): GapScore {
  let hostile = 0;
  let prevented = 0;
  let falsePositives = 0;
  const slips: GapSlip[] = [];
  const falsePositiveCases: string[] = [];

  for (const o of outcomes) {
    if (o.intendedHostile) {
      hostile++;
      if (o.blocked) prevented++;
      else slips.push({ name: o.name, input: o.input });
    } else if (o.blocked) {
      falsePositives++;
      falsePositiveCases.push(o.name);
    }
  }

  const slipped = hostile - prevented;
  const preventedPct = hostile === 0 ? 100 : Math.round((prevented / hostile) * 1000) / 10;
  return { total: outcomes.length, hostile, prevented, preventedPct, slipped, slips, falsePositives, falsePositiveCases };
}

/**
 * Run cases through the REAL deterministic engine to produce decided outcomes.
 * The offline bridge from a generated/committed corpus to a GapScore. Deterministic
 * (same cases + ruleset -> same outcomes); never throws (the engine fails open).
 */
export function runGapCases(cases: readonly GapCase[], ruleset: ForcefieldRuleset = DEFAULT_RULESET): GapOutcome[] {
  return cases.map((c) => {
    const d = decideEnforcement(
      {
        path: c.input.path,
        rawUrl: c.input.rawUrl ?? c.input.path,
        method: c.input.method,
        userAgent: c.input.userAgent,
        headerNames: c.input.headerNames,
      },
      ruleset,
    );
    return { name: c.name, intendedHostile: c.intendedHostile, blocked: d.block, input: c.input };
  });
}

/** Convenience: run a corpus and score it in one call (the offline path). */
export function scoreGapForCases(cases: readonly GapCase[], ruleset: ForcefieldRuleset = DEFAULT_RULESET): GapScore {
  return scoreGap(runGapCases(cases, ruleset));
}
