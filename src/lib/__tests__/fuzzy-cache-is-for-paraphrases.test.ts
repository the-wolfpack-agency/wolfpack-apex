/**
 * The cache must not answer a different question.
 *
 * Measured against production on 2026-08-23. Two prompts identical for
 * 6,046 characters, one ending "APPROVED in full" and the other "DENIED
 * for lack of evidence", scored 0.870 on token-set Jaccard and the denied
 * claim came back as "Approved", in 180ms, at zero cost.
 *
 * A cache that saves money by answering a different question is worse
 * than no cache, and for a warranty claim it is worse than that.
 */

export {};

import {
  FUZZY_MAX_MESSAGE_CHARS,
  normalizeQuestionForCache,
} from "@/lib/assistant";

/* The same shape the cache uses to build its key. Reproduced rather than
   imported because the helpers are module-private, and the point of this
   suite is the PROPERTY of the key, not its call site. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at",
  "for", "with", "was", "is", "are", "be", "it", "this", "that", "as",
  "by", "from", "no",
]);
function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeQuestionForCache(text)
      .split(" ")
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const QUESTION =
  "Read the claim notes below and answer with one word: was the final verdict approved or denied?\n\n";
const BODY =
  "Claim note: routine service performed, no fault found, vehicle returned to customer. ".repeat(70);
const APPROVED = `${QUESTION}${BODY} FINAL VERDICT: the claim was APPROVED in full.`;
const DENIED = `${QUESTION}${BODY} FINAL VERDICT: the claim was DENIED for lack of evidence.`;

describe("why the key cannot tell these apart", () => {
  it("scores the two opposite claims as near-identical", () => {
    /* The number that shipped the wrong answer. */
    const score = jaccard(tokenSet(APPROVED), tokenSet(DENIED));
    expect(score).toBeGreaterThan(0.8);
  });

  it("collapses six kilobytes of notes into about twenty words", () => {
    /* The key is a set of UNIQUE tokens, so everything repeated
       contributes nothing and the score saturates on length alone. */
    expect(BODY.length).toBeGreaterThan(5_000);
    expect(tokenSet(APPROVED).size).toBeLessThan(30);
  });

  it("cannot see the deciding word, because the question names both", () => {
    /* "approved" and "denied" are in EVERY token set here: the question
       asks which one it was. The one fact that decides the answer is
       invisible to the key by construction, not by accident. */
    for (const set of [tokenSet(APPROVED), tokenSet(DENIED)]) {
      expect(set.has("approved")).toBe(true);
      expect(set.has("denied")).toBe(true);
    }
  });
});

describe("what the bound lets through", () => {
  it("keeps the case this cache actually catches", () => {
    /* The savings are real and worth keeping: the same question typed
       twice should be free the second time.
       Worth being accurate about what "twice" means here. The code calls
       this paraphrase matching, and measured, it is narrower than that:
       "what's" tokenises to "whats" and scores 0.600 against "what is",
       under the 0.8 threshold. What it reliably catches is punctuation
       and capitalisation, which is still the commonest way the same
       question arrives twice. */
    const a = "What is our pricing model?";
    const b = "what is our pricing model";
    expect(a.length).toBeLessThanOrEqual(FUZZY_MAX_MESSAGE_CHARS);
    expect(jaccard(tokenSet(a), tokenSet(b))).toBeGreaterThanOrEqual(0.8);
  });

  it("does not reach a contraction, and the comment above says why", () => {
    /* Pinned so the claim in this file stays true rather than becoming
       folklore about what the cache does. */
    expect(
      jaccard(tokenSet("what is our pricing model"), tokenSet("what's our pricing model")),
    ).toBeLessThan(0.8);
  });

  it("puts a prompt carrying a document out of reach of fuzzy matching", () => {
    expect(APPROVED.length).toBeGreaterThan(FUZZY_MAX_MESSAGE_CHARS);
    expect(DENIED.length).toBeGreaterThan(FUZZY_MAX_MESSAGE_CHARS);
  });

  it("leaves room for a real question and no room for a payload", () => {
    /* Long enough for anything somebody types, short enough that a
       pasted record is out. A question nobody would type in one breath
       is not a paraphrase of anything. */
    expect(FUZZY_MAX_MESSAGE_CHARS).toBeGreaterThanOrEqual(200);
    expect(FUZZY_MAX_MESSAGE_CHARS).toBeLessThanOrEqual(1_000);
  });
});
