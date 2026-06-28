/**
 * UX / Accessibility POSTURE SCORE - a graded, at-a-glance usability + a11y
 * health for a target, trended over time exactly like the SECURITY posture grade
 * (src/lib/report-sections-engagement.ts `postureGrade`).
 *
 * This MIRRORS the security posture's A -> F scale and its "criticals fail
 * outright" instinct, but it scores a DIFFERENT slice of the same finding stream:
 * only `ux_gap`-category findings, split into accessibility (title prefixed
 * "Accessibility:") vs general UX. A client sees one headline ("UX posture: B")
 * that moves as the target's usability improves or regresses.
 *
 * PURE + DETERMINISTIC: input findings -> output grade. No I/O, no clock, no
 * randomness. Same findings always yield the same grade, so a regression in the
 * grade is a real regression in the target, never test flake.
 *
 * --- Why a WEIGHTED severity score, not a simple count ---
 *
 * A naive count-based scheme ("N findings -> grade") treats one high-severity
 * a11y blocker (e.g. a form with no labels, unusable by a screen reader) the same
 * as N trivial low-severity nits (a slightly-off contrast ratio). That is wrong:
 * a single high-severity gap can make a journey unusable for a whole class of
 * users, while a pile of lows is cosmetic. A count-based grade lets a target
 * "improve" by fixing ten lows while ignoring the one blocker - the grade goes up
 * while real usability stays broken.
 *
 * The WEIGHTED scheme fixes this. Each finding contributes points by severity:
 *
 *     high = 10, medium = 3, low = 1
 *
 * The weights are chosen so a SINGLE high (10) outscores NINE lows (9): one
 * blocker dominates many nits, which is the behavior we want. They are also
 * "super-additive" across bands - a high is worth more than three mediums (10 > 9)
 * and a medium more than two lows (3 > 2) - so severity is never out-traded by
 * volume of a lower band.
 *
 * (`critical` is not a severity the ux_gap bucket emits today - UX gaps top out at
 * high in the classifier - but we weight it defensively at 20 so a future critical
 * ux_gap cannot be under-counted. It is folded into the "high" line of bySeverity
 * for the headline, since the security posture already owns the critical band.)
 *
 * Grade thresholds on the total weighted score:
 *
 *     0           -> A   (no UX/a11y gaps at all - clean bill)
 *     1 .. 2      -> B   (a low nit or two; hardening recommended)
 *     3 .. 9      -> C   (a medium gap, or several lows)
 *     10 .. 19    -> D   (a high-severity blocker present)
 *     20+         -> F   (multiple high-severity blockers / a critical)
 *
 * The boundaries fall on the weights deliberately: one high (10) lands exactly at
 * D, two highs (20) at F, one medium (3) at C, one low (1) at B. So the grade
 * reads back to the worst thing present, with volume only able to push WITHIN the
 * implied band, never across it on lows alone.
 */

import type { ScanFinding, ScanSeverity } from "./types";

/** Severity -> weighted points. Tuned so one high (10) > nine lows (9): a single
 *  blocker dominates many nits. critical weighted defensively (see file header). */
export const UX_SEVERITY_WEIGHT: Record<ScanSeverity, number> = {
  critical: 20,
  high: 10,
  medium: 3,
  low: 1,
};

export type UxGrade = "A" | "B" | "C" | "D" | "F";

export interface UxPostureScore {
  /** Headline A -> F grade, mirroring the security posture scale. */
  grade: UxGrade;
  /** Count of general (non-a11y) ux_gap findings considered. */
  ux: number;
  /** Count of accessibility ux_gap findings (title prefixed "Accessibility:"). */
  a11y: number;
  /** Total ux_gap findings considered (ux + a11y). */
  total: number;
  /** Open ux_gap findings broken out by severity (the headline detail). critical
   *  is folded into high for display since UX gaps top out at high today. */
  bySeverity: { high: number; medium: number; low: number };
  /** The raw weighted severity score the grade was derived from. Exposed so the
   *  UI / a caller can trend the underlying number, not just the letter. */
  score: number;
}

/** An a11y finding is a ux_gap whose title is prefixed "Accessibility:" - the
 *  marker the classifier stamps on accessibility gaps. Case-insensitive + trimmed
 *  so a minor casing drift never silently mis-buckets a finding. */
export function isAccessibilityFinding(f: ScanFinding): boolean {
  return f.title.trim().toLowerCase().startsWith("accessibility:");
}

/**
 * Score the UX / accessibility posture of a set of findings.
 *
 * Considers ONLY `ux_gap`-category findings; security, bug, performance, and
 * broken_journey findings are ignored (they belong to other posture surfaces).
 * 0 ux_gap findings = grade A.
 *
 * Pure: no side effects, deterministic for a given input.
 */
export function scoreUxPosture(findings: ScanFinding[]): UxPostureScore {
  const uxGaps = findings.filter((f) => f.category === "ux_gap");

  let a11y = 0;
  let ux = 0;
  let score = 0;
  const bySeverity = { high: 0, medium: 0, low: 0 };

  for (const f of uxGaps) {
    if (isAccessibilityFinding(f)) a11y += 1;
    else ux += 1;

    score += UX_SEVERITY_WEIGHT[f.severity] ?? 0;

    // critical folds into the high line for the headline (UX gaps top out at high
    // today; a future critical still surfaces in the worst-band count).
    if (f.severity === "critical" || f.severity === "high") bySeverity.high += 1;
    else if (f.severity === "medium") bySeverity.medium += 1;
    else if (f.severity === "low") bySeverity.low += 1;
  }

  return {
    grade: gradeFromScore(score),
    ux,
    a11y,
    total: uxGaps.length,
    bySeverity,
    score,
  };
}

/** Map the weighted score to a letter. Thresholds documented in the file header;
 *  exported so the boundaries are directly unit-testable. */
export function gradeFromScore(score: number): UxGrade {
  if (score <= 0) return "A";
  if (score <= 2) return "B";
  if (score <= 9) return "C";
  if (score <= 19) return "D";
  return "F";
}
