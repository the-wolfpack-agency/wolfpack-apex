/**
 * A guess with a citation on it is worse than an honest question.
 *
 * MEASURED AGAINST THE PRODUCTION CORPUS, 2026-08-30:
 *
 *   "how much do we owe upfront?"
 *     0.419 25100_April 2025 1of2.pdf
 *     0.410 25100_April 2025 2of2.pdf
 *     0.400 BA101 10.20.25.pdf
 *     -> quoted a chauffeur invoice, confidently, with a dollar figure
 *
 *   "what are the payment terms in our SOW?"
 *     0.552 / 0.513 / 0.468, all viaPeople Work Order
 *     -> answered correctly
 *
 * Neither failing question names a subject. "Upfront on what?" is what a
 * person would ask back, and the product already knows how to ask it: the same
 * corpus answered "when do we have to pay?" with "the closest things I hold
 * are... name it and I will read it".
 *
 * WHY THE OLD GUARD MISSED IT. Disambiguation only fired when the relevance
 * JUDGE rejected the hits. Here the judge accepted them, correctly: an invoice
 * genuinely is relevant to owing money. Relevance was never the problem.
 * AGREEMENT was.
 */

import { detectAmbiguity, LEAD_MARGIN, CONFIDENT_SCORE } from "@/lib/brain/ambiguous-question";

const hit = (document_filename: string, score: number) => ({ document_filename, score });

describe("the two cases this was built from", () => {
  it("answers when the hits agree on one document", () => {
    expect(
      detectAmbiguity([
        hit("viaPeople Work Order.pdf", 0.552),
        hit("viaPeople Work Order.pdf", 0.513),
        hit("viaPeople Work Order.pdf", 0.468),
      ]),
    ).toBeNull();
  });

  it("asks when weak evidence is spread across unrelated documents", () => {
    const a = detectAmbiguity([
      hit("25100_April 2025 1of2.pdf", 0.419),
      hit("25100_April 2025 2of2.pdf", 0.410),
      hit("BA101 10.20.25.pdf", 0.400),
    ]);
    expect(a).not.toBeNull();
    expect(a!.candidates).toHaveLength(3);
    expect(a!.candidates[0]).toContain("25100_April 2025 1of2");
  });
});

describe("when it stays out of the way", () => {
  /* Four chunks of one file is ONE candidate to the person reading. Counting
     them as four is how a single well-matched document looks like a crowd. */
  it("does not treat one document's many chunks as a choice", () => {
    expect(
      detectAmbiguity([hit("SOW.pdf", 0.41), hit("SOW.pdf", 0.40), hit("SOW.pdf", 0.39)]),
    ).toBeNull();
  });

  /* A confident leader answers whatever else is nearby: at that strength the
     match is not luck. */
  it("answers on a strong top hit even with close company", () => {
    expect(
      detectAmbiguity([hit("SOW.pdf", CONFIDENT_SCORE + 0.01), hit("Invoice.pdf", CONFIDENT_SCORE)]),
    ).toBeNull();
  });

  /* Winning by a margin is what "the right document" looks like. */
  it("answers when one document clearly leads, even on weak evidence", () => {
    expect(
      detectAmbiguity([hit("SOW.pdf", 0.42), hit("Invoice.pdf", 0.42 - LEAD_MARGIN - 0.01)]),
    ).toBeNull();
  });

  it("says nothing on a single hit or none at all", () => {
    expect(detectAmbiguity([])).toBeNull();
    expect(detectAmbiguity([hit("SOW.pdf", 0.41)])).toBeNull();
  });
});

describe("what it offers when it does ask", () => {
  /* Only the genuinely close ones. Offering a document that lost by a mile
     turns a helpful question into a shrug. */
  it("names only the documents that are actually contending", () => {
    const a = detectAmbiguity([
      hit("A.pdf", 0.42),
      hit("B.pdf", 0.40),
      hit("C.pdf", 0.20),
    ])!;
    expect(a.candidates).toEqual(["A.pdf", "B.pdf"]);
  });

  it("offers at most four, because a longer list is not a choice", () => {
    const a = detectAmbiguity(
      ["A", "B", "C", "D", "E", "F"].map((n, i) => hit(`${n}.pdf`, 0.42 - i * 0.005)),
    )!;
    expect(a.candidates).toHaveLength(4);
  });

  it("puts the best candidate first", () => {
    const a = detectAmbiguity([hit("B.pdf", 0.40), hit("A.pdf", 0.42)])!;
    expect(a.candidates[0]).toBe("A.pdf");
  });

  /* THE BIAS IS DELIBERATE. A wrong ask costs a click; a confident wrong
     answer costs the client's belief in every answer that IS right. But it
     must not ask on everything, so this pins that the common shape answers. */
  it("answers far more often than it asks, on ordinary strong results", () => {
    const ordinary = [0.9, 0.8, 0.7, 0.6, 0.55].map((s, i) => [hit("Doc.pdf", s), hit(`Other${i}.pdf`, s - 0.02)]);
    for (const pair of ordinary) expect(detectAmbiguity(pair)).toBeNull();
  });
});
