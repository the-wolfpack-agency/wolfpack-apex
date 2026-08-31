/**
 * The question matchers must not be a denial-of-service vector.
 *
 * WHAT WAS WRONG. Both matchers put `\s+` and `\s*` next to a lazy `.+?`. Both
 * sides can match the same space, so a message made of spaces forced the engine
 * to try every possible split. Measured 2026-08-30 on "what did " plus N spaces,
 * through `matchDocumentQuestion`:
 *
 *     n=200    10.4ms
 *     n=400    19.7ms
 *     n=800   112.0ms
 *     n=1600  858.8ms
 *
 * Superlinear, on a string anybody can paste into the chat box. Nearly a second
 * of CPU for 1.6KB, on a path that runs before the answer is even attempted.
 *
 * THE PART WORTH REMEMBERING. CodeQL flagged this shape in
 * brain/question-terms.ts as js/polynomial-redos and did NOT flag the identical
 * shape in tools/search.ts, which had been in production for weeks. The scanner
 * finding one instance is not evidence the class is contained, and the fix was
 * applied to both only because the second was measured rather than assumed.
 *
 * Both now normalize whitespace before matching, so the patterns use literal
 * spaces and the ambiguity has nowhere to live.
 */

import { matchDocumentQuestion } from "@/lib/assistant/tools/search";
import { searchTermsFor, isQuestionShaped } from "@/lib/brain/question-terms";

/**
 * Inputs shaped like the ones CodeQL named, each a valid frame prefix followed
 * by the whitespace run that caused the backtracking.
 */
const ADVERSARIAL = [
  (n: number) => "what did " + " ".repeat(n) + "!",
  (n: number) => "what did a" + " ".repeat(n) + "!",
  (n: number) => "what did a say about " + " ".repeat(n) + "!",
  (n: number) => "what in " + " ".repeat(n) + "!",
  (n: number) => "summarize " + " ".repeat(n) + "!",
  (n: number) => "tell me about " + " ".repeat(n) + "!",
  (n: number) => "a summary of " + " ".repeat(n) + "!",
];

function worstMs(fn: (s: string) => unknown, build: (n: number) => string, n: number): number {
  const input = build(n);
  /* One warm pass so the first-call compile is not counted as the cost. */
  fn(build(8));
  const t0 = process.hrtime.bigint();
  fn(input);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe.each([
  ["matchDocumentQuestion", (s: string) => matchDocumentQuestion(s)],
  ["searchTermsFor", (s: string) => searchTermsFor(s)],
] as const)("%s resists a whitespace flood", (_label, fn) => {
  /* GENEROUS ON PURPOSE. The failing version took 859ms at n=1600, so a 250ms
     ceiling fails loudly on a regression while leaving room for a slow or
     loaded CI machine. This asserts "not superlinear", not a benchmark. */
  const CEILING_MS = 250;

  it.each(ADVERSARIAL.map((b, i) => [i, b]))("shape %i stays fast at 4000 chars", (_i, build) => {
    expect(worstMs(fn, build as (n: number) => string, 4000)).toBeLessThan(CEILING_MS);
  });

  /* Doubling the input must not multiply the time. The old code roughly
     quadrupled; this asserts the growth is bounded well below that. */
  it("does not blow up when the input doubles", () => {
    const build = ADVERSARIAL[0];
    const small = Math.max(worstMs(fn, build, 2000), 0.5);
    const large = worstMs(fn, build, 4000);
    expect(large / small).toBeLessThan(8);
  });
});

/**
 * The fix must not have changed what the matchers actually do. Normalizing
 * whitespace is supposed to be invisible to a person typing normally.
 */
describe("normalizing whitespace did not change any answer", () => {
  it.each([
    ["what does the SOW say about payment", null],
    ["what documents do we have about onboarding", "onboarding"],
    ["what is in the SharePoint about training", "training"],
    ["do we have anything on invoices", "invoices"],
  ])("%s still resolves the same way", (prompt, expected) => {
    expect(matchDocumentQuestion(prompt)).toBe(expected);
  });

  /* Extra spaces a person actually types must behave like single ones, which
     is the user-visible half of the same change. */
  it("treats doubled spaces the way a reader would expect", () => {
    expect(matchDocumentQuestion("what  documents   do we  have about onboarding")).toBe(
      "onboarding",
    );
    expect(searchTermsFor("summarize   the  onboarding document")).toBe("onboarding document");
    expect(isQuestionShaped("  what does the SOW say  ")).toBe(true);
  });

  /* A message too long to be a document question is refused rather than
     parsed, which is the length bound doing its job. */
  it("declines an absurdly long message instead of parsing it", () => {
    expect(matchDocumentQuestion("summarize the " + "a".repeat(900))).toBeNull();
    const long = "summarize the " + "a".repeat(900);
    expect(searchTermsFor(long)).toBe(long);
  });
});
