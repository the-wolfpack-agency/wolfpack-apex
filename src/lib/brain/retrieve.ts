/**
 * Retrieve, judge, and if the judge says no, ask again in other words.
 *
 * WHY THIS EXISTS RATHER THAN LIVING IN tryBrain
 *
 * The judge ran inside the assistant and the eval measured queryBrain, so the
 * eval graded a path the product does not take. That is how query expansion
 * shipped unproven: its trigger is a judge rejection, and the only harness that
 * could have tested it never called the judge.
 *
 * A measurement that grades a different path than the one that runs is worse
 * than no measurement, because it reports numbers with the authority of a test.
 *
 * So the loop lives here and both callers use it. The assistant gets the same
 * behavior it had; the eval finally grades what a person experiences.
 *
 * EVERYTHING EXPENSIVE IS INJECTED. This module knows the ORDER of operations
 * and nothing about how to spend money: no model client, no prompt, no cost.
 * A caller that passes neither judge nor expander gets plain retrieval, which
 * is exactly what the callers that do not want to pay should get.
 */
import { queryBrain, type QueryExecution, type QueryOpts } from "./query";
import { shouldExpand } from "./expand-query";
import { searchTermsFor } from "./question-terms";
import { SEMANTIC_SCORE_FLOOR } from "./qdrant";

export interface RetrieveOpts extends Omit<QueryOpts, "expand"> {
  /**
   * Decide whether the retrieved material answers the question.
   *
   * Returning "irrelevant" is the signal that the words did not match the
   * corpus, which is the one moment different words are worth paying for.
   */
  judge?: (question: string, hits: QueryExecution["hits"]) => Promise<"relevant" | "irrelevant" | "unjudged">;
  /** Rewrite the question into the words documents use. */
  expand?: (question: string) => Promise<string>;
}

export interface RetrieveResult {
  execution: QueryExecution;
  /** True when the judge rejected the FIRST attempt. */
  firstWasRejected: boolean;
  /** True when a rewrite was tried. */
  expanded: boolean;
  /** The rewritten question, when one was used. */
  rewritten?: string;
  /** True when the second attempt was kept. */
  expansionHelped: boolean;
}

/**
 * How close two scores have to be before COUNT is allowed to decide.
 *
 * Scores are similarities on 0..1. Below this the two attempts found material
 * of the same quality and more of it is genuinely more useful to the model;
 * above it, one of them is simply about a different subject.
 */
const SCORE_TIE = 0.05;

/**
 * Better means a stronger best hit. Count breaks a tie, and only a tie.
 *
 * IT USED TO LEAD WITH COUNT, and that was backwards in every case that can
 * reach it. Look at what triggers a rewrite: shouldExpand fires when the judge
 * called the first pass irrelevant, when it found nothing, or when its top
 * score was under the floor. All three are RELEVANCE failures, so ranking the
 * two attempts by volume answers a question nobody asked.
 *
 * What it did in practice: a first pass returning three passages at 0.88 that
 * the judge rejected, against a broad rewrite returning eight at 0.41, kept the
 * eight. That is how a question about payment terms came back holding a
 * restaurant deposit receipt. More results that are all wrong is not a better
 * answer, it is a longer one.
 */
function isBetter(a: QueryExecution, b: QueryExecution): boolean {
  const aScore = a.hits[0]?.score ?? 0;
  const bScore = b.hits[0]?.score ?? 0;
  if (Math.abs(aScore - bScore) > SCORE_TIE) return aScore > bScore;
  return a.hits.length > b.hits.length;
}

export async function retrieve(opts: RetrieveOpts): Promise<RetrieveResult> {
  const { judge, expand, ...queryOpts } = opts;

  /* SEARCH THE TOPIC, JUDGE THE QUESTION.
   *
   * Keyword search ANDs its terms, so one scaffolding word the corpus does not
   * contain zeroes out an otherwise perfect match: "what does the viaPeople
   * work order say" found nothing while "what is in the viaPeople work order"
   * scored 0.900 on the same document.
   *
   * The judge still sees the ORIGINAL sentence, because it is deciding whether
   * these results answer what a person actually asked, and handing it the
   * reduced terms would ask it a different and easier question. */
  const terms = searchTermsFor(opts.query);
  const first = await queryBrain({ ...queryOpts, query: terms });

  const verdict =
    judge && first.hits.length > 0 ? await judge(opts.query, first.hits).catch(() => "unjudged" as const) : "unjudged";
  const firstWasRejected = verdict === "irrelevant";

  const worthRetrying = shouldExpand(
    {
      hitCount: first.hits.length,
      topScore: first.hits[0]?.score ?? 0,
      judgedIrrelevant: firstWasRejected,
    },
    SEMANTIC_SCORE_FLOOR,
  );

  if (!expand || !worthRetrying) {
    return { execution: first, firstWasRejected, expanded: false, expansionHelped: false };
  }

  const rewritten = await expand(opts.query).catch(() => opts.query);
  /* A rewrite that changed nothing is not worth a second retrieval. */
  if (rewritten === opts.query) {
    return { execution: first, firstWasRejected, expanded: false, expansionHelped: false };
  }

  const second = await queryBrain({ ...queryOpts, query: searchTermsFor(rewritten) });

  /* THE SECOND ATTEMPT IS JUDGED TOO, AND ONLY WHEN THAT MEANS SOMETHING.
   *
   * When the judge rejected the first pass it has already said those passages
   * are about the wrong thing, and nothing was asking it about the second. So
   * "expansionHelped" was a claim with no measurement under it: a rewrite could
   * retrieve a higher-scoring passage about an equally wrong subject and be
   * recorded as a success. Scores say how alike two pieces of text are, not
   * whether either answers the question.
   *
   * Paid for only on the path that already decided to pay for a rewrite, and
   * only when the first pass was rejected. A first pass that was merely thin
   * needs no second opinion: the scores are comparable and can settle it. */
  const secondVerdict =
    judge && firstWasRejected && second.hits.length > 0
      ? await judge(opts.query, second.hits).catch(() => "unjudged" as const)
      : "unjudged";

  /* A VERDICT OUTRANKS A SCORE, which is the whole reason the judge exists.
   *
   * Once the first pass has been rejected, comparing scores asks the wrong
   * question: a score says how alike two pieces of text are, and the judge has
   * already said this one is about the wrong subject. A rewrite the judge
   * ACCEPTS wins even when its best hit scores lower, because a lower-scoring
   * passage that answers the question beats a higher-scoring one that does not.
   *
   * Getting this wrong in the other direction was the first version of this
   * fix: it ranked by score throughout and would have kept material the judge
   * had just rejected, over material the judge had just accepted. */
  const helped =
    firstWasRejected && secondVerdict === "relevant"
      ? true
      : /* Both wrong. The rewrite found different wrong material, and keeping
           it would put words the person never typed in front of a wrong
           answer. Keep the first and record honestly that nothing helped. */
        firstWasRejected && secondVerdict === "irrelevant"
        ? false
        : /* The first pass was thin rather than wrong, so no verdict is in
             play and the scores are comparable. */
          isBetter(second, first);

  return {
    /* KEEPS THE BETTER OF THE TWO, and keeps the ORIGINAL question on the
       result: a rewrite is a guess about vocabulary, and the query log should
       record what the person actually typed. An eval harvested from rewritten
       questions would grade the product on its own paraphrases. */
    execution: helped ? { ...second, query: opts.query } : { ...first, query: opts.query },
    firstWasRejected,
    expanded: true,
    rewritten,
    expansionHelped: helped,
  };
}
