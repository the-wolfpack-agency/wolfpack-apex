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
     failure, and it is invisible to every number here. */
  if (first.judgedIrrelevant) return true;
  if (first.hitCount === 0) return true;
  /* Found something, but nothing convincing. The floor is passed in rather
     than restated so this cannot disagree with the retriever about what
     "convincing" means. */
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
