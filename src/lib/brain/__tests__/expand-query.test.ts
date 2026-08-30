/**
 * Ask again in the words the documents use.
 *
 * Four of twelve labelled questions never surface their document, and all four
 * are the same shape: the person and the paper describe one fact differently.
 *
 *   asked   "how much do we owe upfront?"
 *   written "50% ($6,000.00) is due within 30 days of the execution"
 *
 * No amount of ranking fixes that. Neither retriever can match words that are
 * not there.
 */
import {
  shouldExpand,
  parseExpansion,
  EXPANSION_SYSTEM,
  EXPANSION_MAX_TOKENS,
} from "@/lib/brain/expand-query";

const FLOOR = 0.36;

describe("deciding whether to pay for a second attempt", () => {
  it("expands when the first pass found nothing", () => {
    expect(shouldExpand({ hitCount: 0, topScore: 0 }, FLOOR)).toBe(true);
  });

  it("expands when it found something unconvincing", () => {
    expect(shouldExpand({ hitCount: 5, topScore: 0.2 }, FLOOR)).toBe(true);
  });

  /* THE COST ARGUMENT. Two thirds of questions already find their document at
     rank one; paying for all of them to help the third that struggles is the
     fixed-cascade mistake in a different costume. */
  it("does not expand after a confident retrieval", () => {
    expect(shouldExpand({ hitCount: 5, topScore: 0.55 }, FLOOR)).toBe(false);
  });

  /* Expanding after a GOOD retrieval risks replacing a correct answer with a
     differently-worded one: a regression that looks like a feature. */
  it("treats the floor as the boundary, not a suggestion", () => {
    expect(shouldExpand({ hitCount: 3, topScore: FLOOR }, FLOOR)).toBe(false);
    expect(shouldExpand({ hitCount: 3, topScore: FLOOR - 0.01 }, FLOOR)).toBe(true);
  });
});

describe("the trigger that actually matters", () => {
  /* THE ONE I GOT WRONG. Gating on a thin result seemed obvious and fired on
     nothing: measured against the labelled set, "how much do we owe upfront?"
     retrieves four hits scoring 0.42 to 0.45, comfortably above the floor.
     They are the wrong documents, and no score can say so. The eval caught it
     by changing nothing at all between two runs. */
  it("expands when the judge says the material does not answer the question", () => {
    expect(
      shouldExpand({ hitCount: 4, topScore: 0.45, judgedIrrelevant: true }, FLOOR),
    ).toBe(true);
  });

  it("does not expand on the same numbers when the judge accepted them", () => {
    expect(
      shouldExpand({ hitCount: 4, topScore: 0.45, judgedIrrelevant: false }, FLOOR),
    ).toBe(false);
  });
});

describe("cleaning the rewrite", () => {
  it("takes the terms when the model behaves", () => {
    expect(parseExpansion("deposit initial payment due upon execution", "how much upfront?")).toBe(
      "deposit initial payment due upon execution",
    );
  });

  /* A model asked for "terms only" still preambles, and a query containing
     "Sure, here are the terms:" retrieves worse than the original. */
  it.each([
    "Sure, here are the search terms: deposit due on execution",
    'Query: deposit due on execution',
    '"deposit due on execution"',
  ])("strips the preamble from %s", (raw) => {
    expect(parseExpansion(raw, "orig")).toBe("deposit due on execution");
  });

  it("takes the last line when the model explains itself first", () => {
    expect(
      parseExpansion("I rewrote this to match contract language.\ndeposit payable on execution", "orig"),
    ).toBe("deposit payable on execution");
  });

  /* REFUSES ITS OWN OUTPUT WHEN IT LOOKS WRONG. A bad expansion is worse than
     none, because it retrieves confidently from the wrong place. */
  it.each([
    ["", "empty"],
    ["ab", "too short to carry meaning"],
    ["I cannot rewrite that question", "a refusal"],
    ["x".repeat(400), "prose rather than terms"],
  ])("falls back to the original on %s (%s)", (raw) => {
    expect(parseExpansion(raw, "the original question")).toBe("the original question");
  });
});

describe("the instruction", () => {
  /* Proper nouns are the one thing a rewrite must not touch: "viaPeople"
     turned into "the vendor" retrieves nothing. */
  it("tells the model to keep proper nouns", () => {
    expect(EXPANSION_SYSTEM).toMatch(/proper noun/i);
  });

  it("asks for terms rather than prose", () => {
    expect(EXPANSION_SYSTEM).toMatch(/terms only/i);
    expect(EXPANSION_MAX_TOKENS).toBeLessThanOrEqual(80);
  });
});
