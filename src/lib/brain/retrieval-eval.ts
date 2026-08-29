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
export interface LabelledPair {
  question: string;
  /**
   * A distinctive fragment of the correct document's filename.
   *
   * A fragment rather than the whole name, because real filenames carry
   * timestamps and duplicate counters that change when a file is re-synced,
   * and an eval set that breaks on a re-upload gets deleted rather than fixed.
   */
  expectFilename: string;
}

/** What retrieval returned, in order. */
export interface RankedResult {
  filename: string;
}

export interface PairOutcome {
  pair: LabelledPair;
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
  misses: LabelledPair[];
}

/** Case-insensitive, and tolerant of the separators filenames actually use. */
function matches(filename: string, fragment: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]+/g, " ");
  return norm(filename).includes(norm(fragment));
}

export function gradeRetrieval(
  pairs: LabelledPair[],
  run: (question: string) => RankedResult[],
): EvalReport {
  const outcomes: PairOutcome[] = pairs.map((pair) => {
    const results = run(pair.question);
    const idx = results.findIndex((r) => matches(r.filename, pair.expectFilename));
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
export function isBetter(before: EvalReport, after: EvalReport): boolean {
  return after.mrr > before.mrr;
}

/** The report as a line somebody can paste into a pull request. */
export function describeEval(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return (
    `${report.outcomes.length} labelled questions: ` +
    `${pct(report.recall)} found, ${pct(report.precisionAtOne)} ranked first, ` +
    `MRR ${report.mrr.toFixed(3)}` +
    (report.misses.length > 0 ? `, ${report.misses.length} never found` : "")
  );
}
