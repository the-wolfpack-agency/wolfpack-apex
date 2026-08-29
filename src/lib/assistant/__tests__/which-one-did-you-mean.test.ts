/**
 * Found documents, could not tell which one, so ask.
 *
 * "When do we have to pay?" retrieves five real documents from the reader's own
 * library. The relevance judge rules that none answers THAT question, which is
 * fair — pay for what? — and the retrieval is discarded. The quality gate then
 * sees an empty context and the reader is told, measured on the deployed URL
 * 2026-08-29:
 *
 *   "I don't have a confident answer for that. Could you rephrase, or open a
 *    support ticket so a human can look at it?"
 *
 * It is not true: we did not come up empty, we are holding several documents
 * about payment. And it routes a four-word clarification to a human, which on a
 * first day reads as a product that does not work.
 */
import {
  whichOneDidYouMean,
  readableDocumentName,
} from "@/lib/assistant/which-one-did-you-mean";

describe("naming a document the way a person would", () => {
  /* Real filenames out of the corpus. Offering these verbatim asks somebody to
     choose between two strings of punctuation. */
  it.each([
    ["viaPeople Work Order_Wolfpack Agency_360 Feedback_5-7-25[36].docx.pdf", "viaPeople Work Order Wolfpack Agency 360 Feedback"],
    ["25100_April 2025 1of2.pdf", "25100 April 2025 1of2"],
    ["reports/Q3 Summary.docx", "Q3 Summary"],
  ])("%s -> %s", (raw, expected) => {
    expect(readableDocumentName(raw)).toBe(expected);
  });

  /* Never strip a name down to nothing: a blank choice is unpickable. */
  it("keeps something when the name is only an extension", () => {
    expect(readableDocumentName(".pdf").length).toBeGreaterThan(0);
  });
});

describe("asking which one", () => {
  const DOCS = [
    "viaPeople Work Order_Wolfpack Agency.docx.pdf",
    "25100_April 2025 1of2.pdf",
    "BEST-VIP Statement.pdf",
  ];

  it("names the documents instead of refusing", () => {
    const r = whichOneDidYouMean("when do we have to pay?", DOCS)!;
    expect(r.answer).toContain("viaPeople Work Order Wolfpack Agency");
    expect(r.choices).toHaveLength(3);
  });

  /* THE SENTENCE THIS REPLACES. Neither of these may survive. */
  it("does not tell anybody to open a ticket or rephrase", () => {
    const a = whichOneDidYouMean("when do we have to pay?", DOCS)!.answer.toLowerCase();
    expect(a).not.toContain("support ticket");
    expect(a).not.toContain("rephrase");
  });

  it("says what to do next", () => {
    expect(whichOneDidYouMean("q", DOCS)!.answer).toMatch(/ask again naming/i);
  });

  /* One candidate is not a choice: "did you mean X" when X is all there is
     asks a question we already know the answer to. */
  it("states the single candidate rather than offering a choice of one", () => {
    const r = whichOneDidYouMean("q", ["Only Doc.pdf"])!;
    expect(r.choices).toHaveLength(1);
    expect(r.answer).toMatch(/closest thing I have/i);
  });

  it("caps the list so it stays a choice rather than a document dump", () => {
    const many = Array.from({ length: 12 }, (_, i) => `Doc ${i}.pdf`);
    expect(whichOneDidYouMean("q", many)!.choices.length).toBeLessThanOrEqual(4);
  });

  /* Four chunks of one document is one document to the reader. */
  it("deduplicates the same document appearing several times", () => {
    const r = whichOneDidYouMean("q", ["A.pdf", "A.pdf", "A.docx.pdf", "B.pdf"])!;
    expect(r.choices).toEqual(["A", "B"]);
  });

  /* THE IMPORTANT NULL. With nothing to offer this must not invent a
     friendlier refusal: "which of these did you mean" followed by nothing is
     worse than being told plainly that we found nothing. */
  it("returns null when there is nothing to offer", () => {
    expect(whichOneDidYouMean("q", [])).toBeNull();
    expect(whichOneDidYouMean("q", ["", "  "])).toBeNull();
  });
});
