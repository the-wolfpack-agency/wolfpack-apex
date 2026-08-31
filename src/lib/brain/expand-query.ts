/**
 * Ask again in the words the documents use.
 *
 * THE FAILURE THIS TARGETS
 *
 * Measured against the labeled set, four of twelve questions never surface the
 * document that answers them, and all four are the same shape: the person and
 * the paper describe one fact differently.
 *
 *   asked   "how much do we owe upfront?"
 *   written "50% ($6,000.00) is due within 30 days of the execution"
 *
 * No amount of ranking fixes that. Neither retriever can match words that are
 * not there: keyword has nothing in common, and the embedding of a short
 * colloquial question sits some distance from a paragraph of contract prose.
 *
 * WHEN IT RUNS, WHICH IS THE WHOLE COST ARGUMENT
 *
 * Only after a first pass came back thin. An expansion on every question would
 * add a model call to every question, and roughly two thirds of them already
 * find their document at rank one. Paying for all of those to help the third
 * that struggles is the same mistake as a fixed reviewer cascade: it buys the
 * expensive option and calls it thoroughness.
 *
 * So the cheap path stays cheap and the hard question gets one extra cheap-tier
 * call, which is the argument the router exists to make.
 *
 * WHAT IT MAY NOT DO
 *
 * It rewrites the QUESTION, never the answer, and the rewritten question is
 * used for retrieval only. Nothing downstream is told the person asked
 * something they did not: the answer still has to come from a document, still
 * gets cited, and still faces the relevance judge. An expansion that went into
 * the answer path would be the model inventing context and calling it
 * retrieval.
 */

/** Enough to rewrite a question, not enough to write prose. */
export const EXPANSION_MAX_TOKENS = 60;

export const EXPANSION_SYSTEM = [
  "Rewrite the question using the words a formal document would use.",
  "Keep every proper noun exactly as written.",
  "Add likely synonyms for informal words: upfront becomes deposit or initial payment,",
  "owe becomes due or payable, get becomes receive or entitled to.",
  "Reply with the rewritten search terms only. No explanation, no punctuation at the end.",
].join(" ");

/** What the first attempt produced. */
export interface FirstPass {
  hitCount: number;
  topScore: number;
  /**
   * The relevance judge decided the retrieved material does not answer this
   * question.
   *
   * THE SIGNAL THAT MATTERS, and the one I got wrong first time. Gating on a
   * thin result seemed obvious and fired on nothing: measured against the
   * labeled set, "how much do we owe upfront?" retrieves four hits scoring
   * 0.42 to 0.45, comfortably above the floor. They are simply the wrong
   * documents, and no score can say so.
   *
   * The judge already makes exactly that call, out loud, on every turn that is
   * about to quote. A rejection is the product telling us the words did not
   * match the corpus, which is precisely when different words are worth
   * paying for.
   */
  judgedIrrelevant?: boolean;
  /**
   * Whether the top hit came from the semantic side.
   *
   * WITHOUT THIS, THE SCORE TEST BELOW COMPARES TWO DIFFERENT SCALES. A
   * semantic score is a cosine similarity and the floor is a real threshold on
   * it. A keyword score is a text-rank number from an entirely different
   * calculation: the retriever treats 0.05 as the bar for a keyword hit worth
   * quoting, so keyword tops sit an order of magnitude under a floor that was
   * never about them.
   *
   * Measured on 30 real queries that had already found something: 26 of them,
   * 87 per cent, would have triggered a paid rewrite. Not one had a semantic
   * top hit. Left alone this would have added a model call and roughly two
   * seconds to almost every question in the product, in the name of rescuing
   * questions that were not failing.
   */
  topIsSemantic?: boolean;
}

/**
 * Is a second, paid attempt worth it?
 *
 * Deliberately conservative on the score path. Expanding after a GOOD
 * retrieval risks replacing a correct answer with a differently-worded one,
 * which is a regression that looks like a feature.
 */
export function shouldExpand(first: FirstPass, semanticFloor: number): boolean {
  /* Retrieved confidently from the wrong place. This is the vocabulary
     failure, it is invisible to every number here, and it is the reason
     expansion exists. */
  if (first.judgedIrrelevant) return true;
  if (first.hitCount === 0) return true;

  /* THE SCORE TEST ONLY APPLIES TO A SCORE THE FLOOR IS ABOUT.
   *
   * Found something, but nothing convincing. The floor is passed in rather
   * than restated so this cannot disagree with the retriever about what
   * "convincing" means, and for the same reason it is only asked about
   * semantic hits: it is a threshold on cosine similarity, and a keyword rank
   * is not a cosine similarity.
   *
   * There is deliberately no keyword equivalent. We have a validated floor for
   * one scale and none for the other, and inventing a number here would be
   * guessing at the exact place a wrong guess is most expensive. A keyword
   * result that is genuinely wrong still gets caught: the judge says so, and
   * that is the branch above. */
  if (!first.topIsSemantic) return false;
  return first.topScore < semanticFloor;
}

/**
 * Clean the model's reply into search terms.
 *
 * A model asked for "search terms only" will still sometimes explain itself,
 * and a rewritten question containing "Sure, here are the terms:" retrieves
 * worse than the original.
 */
export function parseExpansion(raw: string, original: string): string {
  const text = (raw ?? "").trim();
  if (!text) return original;

  /* Take the last line: a model that preambles puts the answer last. */
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const cleaned = line
    /* A whole lead-in, not just its first word. "Sure, here are the search
       terms: X" was leaving "here are the search terms: X", which retrieves
       worse than the original question did.
       
       Anchored on a known opener and bounded to 60 characters before the
       colon, so a legitimate rewrite that happens to contain one — "payment
       terms: net 30" — is not truncated to its tail. */
    .replace(/^(?:sure|ok|okay|here|query|search terms?|the)\b[^:]{0,60}:\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();

  /* REFUSES ITS OWN OUTPUT WHEN IT LOOKS WRONG. Too short to carry meaning, or
     long enough to be prose rather than terms, and the original is the safer
     query: a bad expansion is worse than none because it retrieves confidently
     from the wrong place. */
  if (cleaned.length < 3 || cleaned.length > 300) return original;
  if (/\b(?:I |cannot|sorry|unable)\b/i.test(cleaned)) return original;
  return cleaned;
}

/**
 * Ask a model for the words the documents probably use.
 *
 * Composes the three pieces above the way judgeRelevance composes its own:
 * the caller supplies a completion function and knows nothing about prompts,
 * this knows the prompt and nothing about cost or which model runs it.
 *
 * FALLS BACK TO THE ORIGINAL ON ANY FAILURE, and that is the whole error
 * policy. A rewrite is an optimization; a rewrite that throws should cost a
 * question nothing. Returning the original means retrieve() sees an unchanged
 * string, skips the second retrieval, and the reader gets exactly what they
 * would have got without this.
 */
export async function expandQuestion(
  question: string,
  complete: (input: { system: string; prompt: string; maxTokens: number }) => Promise<string>,
): Promise<string> {
  const original = (question ?? "").trim();
  if (!original) return question;
  try {
    const raw = await complete({
      system: EXPANSION_SYSTEM,
      prompt: original,
      maxTokens: EXPANSION_MAX_TOKENS,
    });
    return parseExpansion(raw, original);
  } catch {
    /* silent-ok: the caller compares the result to the original and does
       nothing when they match, so a failure here is indistinguishable from
       "no better wording exists", which is the correct outcome either way. */
    return original;
  }
}
