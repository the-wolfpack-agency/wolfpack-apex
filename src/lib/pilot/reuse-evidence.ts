/**
 * The reuse claim, as a measurement rather than a sentence in a deck.
 *
 * WHAT THE CLAIM ACTUALLY IS, AFTER MEASURING IT
 *
 * The pitch was "compounding intelligence": the idea that reuse GROWS as the
 * corpus of past answers accumulates. Measured against production on
 * 2026-08-29, that specific claim does not hold. Weekly repeat rate on human
 * traffic:
 *
 *   Jun 08  99.2%    Jul 13  100.0%    Aug 10  100.0%
 *   Jun 22  99.8%    Jul 27   99.6%    Aug 17   94.6%
 *   Jun 29  99.7%    Aug 03   94.0%    Aug 24   97.7%
 *
 * Flat, not rising. It is not compounding because it is already at ceiling and
 * has been since the first week there was traffic.
 *
 * The true claim is stronger and simpler: A SMALL, STABLE SET OF QUESTIONS
 * CARRIES ALMOST ALL THE VOLUME. Last week 1,242 questions were asked and 82
 * were distinct. Answer one well and it is served fifteen times.
 *
 * Saying "compounding" would be claiming a trend the data does not show, and
 * anybody who checked would find the flat line instead of the number. What the
 * data does support does not need the embellishment.
 *
 * WHY THIS IS CODE AND NOT A SLIDE
 *
 * A number in a deck is true on the day it is pasted. This recomputes from the
 * same tables every time, so the claim cannot drift from the product, and a
 * client asking "is that still true" is a query rather than an argument.
 */

/** Everything the claim rests on, measured together so they cannot disagree. */
export interface ReuseEvidence {
  /** Answers delivered to somebody, by any route. */
  answersDelivered: number;
  /** Calls that actually reached a model. */
  modelCalls: number;
  /** Real billed spend on those calls, in USD. */
  modelSpendUsd: number;
  /** Distinct questions behind the volume, over the window. */
  distinctQuestions: number;
  /** Total questions asked over the window. */
  questionsAsked: number;
}

export interface ReuseVerdict {
  /** What each delivered answer actually cost in model spend. */
  costPerAnswerUsd: number;
  /** What one model call costs, measured rather than listed. */
  costPerModelCallUsd: number;
  /**
   * What the same answers would have cost with a model call each.
   *
   * The honest counterfactual for a product that answers every question with a
   * model, which is what most of them do.
   */
  counterfactualUsd: number;
  /** counterfactual / actual. Null when nothing was spent, because a ratio
   *  against zero is a marketing number, not a measurement. */
  timesCheaper: number | null;
  /** How many times an average distinct question was asked. */
  asksPerDistinctQuestion: number | null;
  /** Share of delivered answers that never reached a model, 0..1. */
  zeroModelShare: number;
}

/**
 * Compute the verdict.
 *
 * Pure, so the claim can be tested without a database and so the arithmetic is
 * inspectable rather than buried in SQL.
 */
export function assessReuse(e: ReuseEvidence): ReuseVerdict {
  const costPerModelCallUsd = e.modelCalls > 0 ? e.modelSpendUsd / e.modelCalls : 0;
  const counterfactualUsd = e.answersDelivered * costPerModelCallUsd;
  return {
    costPerAnswerUsd: e.answersDelivered > 0 ? e.modelSpendUsd / e.answersDelivered : 0,
    costPerModelCallUsd,
    counterfactualUsd,
    /* Refused rather than reported as infinity: a product that has spent
       nothing has not proved it is cheap, it has proved it has not run. */
    timesCheaper: e.modelSpendUsd > 0 ? counterfactualUsd / e.modelSpendUsd : null,
    asksPerDistinctQuestion:
      e.distinctQuestions > 0 ? e.questionsAsked / e.distinctQuestions : null,
    zeroModelShare:
      e.answersDelivered > 0
        ? Math.max(0, e.answersDelivered - e.modelCalls) / e.answersDelivered
        : 0,
  };
}

/**
 * The claim in words a client can check, with its own caveats attached.
 *
 * Deliberately states the mechanism, not just the multiple. "13x cheaper" alone
 * invites the question this cannot answer — cheaper than WHICH product — while
 * the mechanism is ours to prove and does not depend on anybody else's pricing.
 */
export function describeReuse(e: ReuseEvidence, v: ReuseVerdict): string[] {
  const lines = [
    `${e.answersDelivered.toLocaleString()} answers delivered for $${e.modelSpendUsd.toFixed(2)} of model spend.`,
    `${(v.zeroModelShare * 100).toFixed(1)}% of them never reached a model at all.`,
  ];
  if (v.asksPerDistinctQuestion !== null) {
    lines.push(
      `${e.questionsAsked.toLocaleString()} questions asked, ${e.distinctQuestions.toLocaleString()} of them distinct: ` +
        `each one answered about ${v.asksPerDistinctQuestion.toFixed(0)} times.`,
    );
  }
  if (v.timesCheaper !== null) {
    lines.push(
      `Answering every one with a model, at our own measured $${v.costPerModelCallUsd.toFixed(5)} per call, ` +
        `would have cost $${v.counterfactualUsd.toFixed(2)}.`,
    );
  }
  /* THE CAVEAT TRAVELS WITH THE CLAIM. Separating them is how a caveat gets
     dropped in the retelling, and this one changes what the number means. */
  lines.push(
    "The counterfactual prices our own calls, not a competitor's. It is what this product would cost " +
      "answering every question with a model, which is how most assistants work.",
  );
  return lines;
}
