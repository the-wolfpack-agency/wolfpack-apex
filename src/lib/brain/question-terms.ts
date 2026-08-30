/**
 * A question is not a search query, and Postgres does not know the difference.
 *
 * THE BUG THIS FIXES, MEASURED 2026-08-30. Three ways of asking one thing:
 *
 *   "what is in the viaPeople work order"    5 hits, top 0.900
 *   "summarize the viaPeople work order"     5 hits, top 0.616
 *   "what does the viaPeople work order say" 0 hits
 *
 * The third finds nothing because `websearch_to_tsquery` joins terms with AND,
 * so the query becomes `viapeopl & work & order & say` and demands the literal
 * word "say" appear in a chunk. It is a question verb, not a topic word. One
 * scaffolding word the corpus happens not to contain zeroes out an otherwise
 * perfect match.
 *
 * WHY IT WAS INVISIBLE UNTIL NOW. Content questions used to be claimed by the
 * search tool, whose matcher did two jobs at once: it decided the routing AND
 * it reduced the sentence to its subject, handing on "SOW payment" rather than
 * "what does the SOW say about payment". The second job was the one keeping
 * retrieval alive, and it was invisible because it lived inside the first.
 *
 * NARROW ON PURPOSE. It strips only scaffolding it recognises, and anything it
 * does not recognise is returned untouched. A general-purpose "remove the
 * question words" pass would eventually eat a word that was the whole point of
 * the question, and a search that quietly drops your subject is worse than one
 * that finds nothing: the first is wrong, the second is honest.
 */

/**
 * Question frames, each capturing the topic and any narrowing clause.
 *
 * Ordered longest-frame-first so "what does X say about Y" is tried before
 * "what does X say", which would otherwise swallow "about Y" into the topic.
 */
const FRAMES: RegExp[] = [
  /* "what does the SOW say about payment" -> "SOW payment" */
  /^\s*(?:what|whats|what's)\s+(?:do(?:es)?|did)\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s+say\s+about\s+(.+?)\s*[?.!]*\s*$/i,
  /* "what does the SOW say" -> "SOW" */
  /^\s*(?:what|whats|what's)\s+(?:do(?:es)?|did)\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s+say\s*[?.!]*\s*$/i,
  /* "what is in the contract about termination" -> "contract termination" */
  /^\s*(?:what|whats|what's)\s+(?:is\s+)?in\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s+about\s+(.+?)\s*[?.!]*\s*$/i,
  /* "what is in the contract" -> "contract" */
  /^\s*(?:what|whats|what's)\s+(?:is\s+)?in\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s*[?.!]*\s*$/i,
  /* "summarise the onboarding doc" -> "onboarding doc" */
  /^\s*(?:can\s+you\s+|please\s+)?summari[sz]e\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s*[?.!]*\s*$/i,
  /* "give me a summary of the SOW" -> "SOW" */
  /^\s*(?:give\s+me\s+|can\s+i\s+get\s+)?an?\s+(?:brief\s+|short\s+|quick\s+)?summary\s+of\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s*[?.!]*\s*$/i,
  /* "tell me about the SOW" -> "SOW" */
  /^\s*tell\s+me\s+about\s+(?:the\s+|our\s+|my\s+|this\s+)?(.+?)\s*[?.!]*\s*$/i,
];

/**
 * A topic made only of pronouns is not a topic.
 *
 * "what does it say" would otherwise search the corpus for "it", which matches
 * nothing useful and everything equally.
 */
const PRONOUN_ONLY = /^(?:it|this|that|they|them|these|those|there)$/i;

/**
 * Reduce a question to the terms worth searching for.
 *
 * Returns the input unchanged when it is not a shape this recognises, which is
 * the common case and the safe one.
 */
export function searchTermsFor(question: string): string {
  const text = (question ?? "").trim();
  if (!text) return text;

  for (const frame of FRAMES) {
    const m = frame.exec(text);
    if (!m) continue;

    const subject = (m[1] ?? "").trim();
    const about = (m[2] ?? "").trim();
    if (!subject || PRONOUN_ONLY.test(subject)) return text;

    /* Both halves, because searching the subject alone returns the whole
       document and buries the clause somebody actually asked about. */
    return about ? `${subject} ${about}` : subject;
  }

  return text;
}

/** Whether this question had scaffolding worth stripping. Useful for logging. */
export function isQuestionShaped(question: string): boolean {
  return searchTermsFor(question) !== (question ?? "").trim();
}

/**
 * Frames that ask about a document AS A WHOLE.
 *
 * The distinction that matters is narrowing, not wording. "What does the SOW
 * say about payment" wants one clause, and quoting the matching chunk answers
 * it exactly, for free, with the source visible. "Summarise the SOW" wants
 * something no single chunk contains, and quoting three of them produces a
 * wall of excerpts that looks like an answer and is not one.
 */
const WHOLE_DOCUMENT: RegExp[] = [
  /^\s*(?:can\s+you\s+|please\s+)?summari[sz]e\s+/i,
  /^\s*(?:give\s+me\s+|can\s+i\s+get\s+)?an?\s+(?:brief\s+|short\s+|quick\s+)?summary\s+of\s+/i,
  /^\s*tell\s+me\s+about\s+/i,
  /^\s*what(?:'?s| is| are)?\s+(?:the\s+)?(?:main\s+|key\s+)?(?:points?|takeaways?|gist)\s+of\s+/i,
  /^\s*(?:what|whats|what's)\s+(?:do(?:es)?|did)\s+.+\s+say\s*[?.!]*\s*$/i,
  /^\s*(?:what|whats|what's)\s+(?:is\s+)?in\s+(?!.*\babout\b).+[?.!]*\s*$/i,
];

/**
 * Does answering this require reading across a document rather than finding a
 * line in it?
 *
 * Callers use this to skip the free quote-the-chunk path and spend a cheap-tier
 * call on a real synthesis. It is deliberately conservative: when unsure it
 * says no, because quoting is cheap, sourced and never invents anything, and
 * an unnecessary model call costs money on every question in the product.
 */
export function asksForSynthesis(question: string): boolean {
  const text = (question ?? "").trim();
  if (!text) return false;
  /* NO GLOBAL "about" VETO, though the first version had one and it was wrong.
     Narrowing is handled inside the frames that can be narrowed: the "say"
     frame anchors at the end so "say about payment" never matches it, and the
     "in" frame excludes it outright. A blanket rule looked equivalent and
     quietly broke "tell me ABOUT the contract", where the word is part of the
     frame rather than a clause. */
  return WHOLE_DOCUMENT.some((r) => r.test(text));
}
