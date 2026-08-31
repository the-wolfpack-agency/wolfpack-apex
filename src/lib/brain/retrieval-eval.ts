/**
 * Grade retrieval against known-correct answers, so ranking changes stop being
 * arguments.
 *
 * WHY THIS EXISTS
 *
 * Retrieval was changed three times in one day: filenames made searchable, then
 * weighted against semantic scores, and before that a relevance judge's input
 * window widened. Each change was justified by one example and validated by
 * re-running that same example. That is not measurement, it is anecdote with a
 * deployment behind it.
 *
 * The specific smell is FILENAME_MATCH_WEIGHT = 9. It is a magic number. It was
 * chosen because 0.1 x 9 clears a semantic score of 0.45, and nothing says
 * whether 6 or 12 would serve real questions better. The standard answer to two
 * incomparable score scales is Reciprocal Rank Fusion, which combines by rank
 * position so the scales never meet. Adopting it means changing ranking for
 * every question in the corpus, and there is currently no way to tell whether
 * that helps or hurts.
 *
 * This is that way. Label a question with the document that answers it, run
 * retrieval, and measure where the right document landed. A ranking change is
 * then better or worse rather than defensible or indefensible.
 *
 * WHY THE PAIRS ARE NOT IN THIS FILE
 *
 * They are supplied per deployment, for the same reason journey probes are. Our
 * corpus is mostly one client's survey exports; pairs built from it would bake
 * their material into the repo and would measure nothing on anybody else's
 * documents. A client's own eval set is also the only one that can tell them
 * their deployment works.
 */

/** One question and the document that actually answers it. */
export interface LabeledPair {
  question: string;
  /**
   * A distinctive fragment of the correct document's filename.
   *
   * A fragment rather than the whole name, because real filenames carry
   * timestamps and duplicate counters that change when a file is re-synced,
   * and an eval set that breaks on a re-upload gets deleted rather than fixed.
   */
  expectFilename: string;
  /**
   * OTHER DOCUMENTS THAT WOULD ALSO BE A CORRECT ANSWER.
   *
   * Some questions genuinely have several right answers and scoring them
   * against one is not strictness, it is a broken ruler. Found on 2026-08-30:
   * "which hotels were surveyed in August" was labeled with a single file and
   * counted as NEVER FOUND, while the corpus holds five August surveys:
   *
   *   Conrad Aug 10-14, Conrad Aug 17-21, Intercontinental Aug 10-14,
   *   Ritz Carlton Las Colinas Aug 17-21, WO 8.10-8.17_All
   *
   * Retrieval was returning a correct document and being marked wrong for it,
   * which is worse than having no eval: it sends somebody optimizing a system
   * that already works. A chunking change was nearly built to fix it.
   *
   * Optional, so every existing pair keeps its meaning untouched.
   */
  alsoAccept?: string[];
}

/** What retrieval returned, in order. */
export interface RankedResult {
  filename: string;
}

export interface PairOutcome {
  pair: LabeledPair;
  /** 1-based position of the first correct document, or null if absent. */
  rank: number | null;
  /** True when it appeared anywhere in the results. */
  found: boolean;
}

export interface EvalReport {
  outcomes: PairOutcome[];
  /** Share of questions whose document appeared at all, 0..1. */
  recall: number;
  /** Share whose document was first. The number a reader actually feels. */
  precisionAtOne: number;
  /**
   * Mean reciprocal rank. Rewards moving the right answer UP, not just
   * including it, which is the whole difference a ranking change makes.
   */
  mrr: number;
  /** Questions whose document never appeared. The list to work on. */
  misses: LabeledPair[];
}

/** Case-insensitive, and tolerant of the separators filenames actually use. */
function matches(filename: string, fragment: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]+/g, " ");
  return norm(filename).includes(norm(fragment));
}

export function gradeRetrieval(
  pairs: LabeledPair[],
  run: (question: string) => RankedResult[],
): EvalReport {
  const outcomes: PairOutcome[] = pairs.map((pair) => {
    const results = run(pair.question);
    /* Any acceptable document counts, and the FIRST one found decides the
       rank: somebody asking a question with several right answers is served
       by whichever arrives first, so that is what the rank should measure. */
    const acceptable = [pair.expectFilename, ...(pair.alsoAccept ?? [])];
    const idx = results.findIndex((r) => acceptable.some((a) => matches(r.filename, a)));
    return { pair, rank: idx === -1 ? null : idx + 1, found: idx !== -1 };
  });

  const n = outcomes.length;
  if (n === 0) {
    /* An empty eval set scores zero, not one hundred percent. A suite with no
       cases passing everything is how a ranking change ships unmeasured. */
    return { outcomes, recall: 0, precisionAtOne: 0, mrr: 0, misses: [] };
  }

  return {
    outcomes,
    recall: outcomes.filter((o) => o.found).length / n,
    precisionAtOne: outcomes.filter((o) => o.rank === 1).length / n,
    mrr: outcomes.reduce((sum, o) => sum + (o.rank ? 1 / o.rank : 0), 0) / n,
    misses: outcomes.filter((o) => !o.found).map((o) => o.pair),
  };
}

/**
 * Is the new ranking better?
 *
 * MRR is the deciding measure because it rewards moving the right document UP,
 * which is exactly what a ranking change does and what recall alone cannot see:
 * a change that lifts the answer from position 5 to position 1 leaves recall
 * identical and transforms what a person experiences.
 *
 * Ties go to the incumbent. A change that cannot demonstrate an improvement is
 * churn, and churn in ranking is how a corpus quietly gets worse one defensible
 * step at a time.
 */
/**
 * Below this many pairs, a comparison decides nothing.
 *
 * On six pairs one question is 17% of the score. RRF was adopted on exactly
 * that basis (MRR 0.557 -> 0.700) and reversed on twelve (0.544 vs 0.503). I
 * had written that six was too few BEFORE adopting it, which is the point: a
 * rule somebody has to remember is a rule that gets skipped by the person in a
 * hurry, and that person is usually the one who wrote it.
 */
export const MIN_PAIRS_FOR_A_VERDICT = 12;

export type Verdict = "better" | "worse" | "no_change" | "not_enough_evidence";

/**
 * Did the change help?
 *
 * Returns `not_enough_evidence` rather than a guess when the set is too small,
 * because a wrong verdict is worse than no verdict: it gets shipped.
 *
 * Ties go to the incumbent. A change that cannot show an improvement is churn,
 * and churn in ranking is how a corpus gets quietly worse one defensible step
 * at a time.
 */
export function judgeChange(before: EvalReport, after: EvalReport): Verdict {
  const n = Math.min(before.outcomes.length, after.outcomes.length);
  if (n < MIN_PAIRS_FOR_A_VERDICT) return "not_enough_evidence";
  if (after.mrr > before.mrr) return "better";
  if (after.mrr < before.mrr) return "worse";
  return "no_change";
}

/**
 * Kept for callers that only want the boolean, and it now REQUIRES a verdict:
 * "not enough evidence" is not "better", which is the whole correction.
 */
export function isBetter(before: EvalReport, after: EvalReport): boolean {
  return judgeChange(before, after) === "better";
}

/** The report as a line somebody can paste into a pull request. */
export function describeEval(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return (
    `${report.outcomes.length} labeled questions: ` +
    `${pct(report.recall)} found, ${pct(report.precisionAtOne)} ranked first, ` +
    `MRR ${report.mrr.toFixed(3)}` +
    (report.misses.length > 0 ? `, ${report.misses.length} never found` : "")
  );
}
