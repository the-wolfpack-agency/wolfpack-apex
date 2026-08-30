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
 * behaviour it had; the eval finally grades what a person experiences.
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

/** Better means more hits, or a stronger best hit. */
function isBetter(a: QueryExecution, b: QueryExecution): boolean {
  if (a.hits.length !== b.hits.length) return a.hits.length > b.hits.length;
  return (a.hits[0]?.score ?? 0) > (b.hits[0]?.score ?? 0);
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
  const helped = isBetter(second, first);

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
