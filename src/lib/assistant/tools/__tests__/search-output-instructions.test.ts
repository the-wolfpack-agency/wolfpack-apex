/**
 * Instructions about the ANSWER'S SHAPE are not search terms.
 *
 * Measured against the live deployment 2026-08-29:
 *
 *   "summarize our SOW payment terms in two sentences"
 *     -> searched for "SOW payment terms in two sentences"
 *     -> "Found 2 results for ... : 2 documents. Go to: Docs"
 *
 * The same question without the trailing instruction answers from the document
 * with the figures and a citation in 1,790ms, so retrieval was never the
 * problem. Four words about formatting were handed to the index as though they
 * were subject matter, and they match nothing, because no document is about
 * being two sentences long.
 *
 * Worse than a miss, it is a CONFIDENT miss: the reader asked for a summary,
 * got a result count, and nothing hinted that their own phrasing caused it.
 */
import { stripOutputInstruction } from "@/lib/assistant/tools/search";

describe("stripping output instructions from a search query", () => {
  it.each([
    ["SOW payment terms in two sentences", "SOW payment terms"],
    ["the onboarding policy briefly", "the onboarding policy"],
    ["invoice totals as a bullet list", "invoice totals"],
    ["the contract in plain english", "the contract"],
    ["status in 3 bullets", "status"],
  ])("%s -> %s", (input, expected) => {
    expect(stripOutputInstruction(input)).toBe(expected);
  });

  /* THE REGRESSION THAT NEARLY SHIPPED. "terms" was in the strip list for the
     sake of "in plain terms", and it turned "SOW payment terms" into "SOW
     payment", mangling the exact query this product answers best. A rare
     phrasing is not worth breaking a common one, and the boundary check caught
     it before it left the machine. */
  it.each(["SOW payment terms", "payment terms", "terms of service"])(
    "never damages %s",
    (q) => {
      expect(stripOutputInstruction(q)).toBe(q);
    },
  );

  /* Trailing only, from a closed list. These read as formatting words but are
     the subject of the question, and a general rule would eat them. */
  it.each([
    "the two sentences clause",
    "brief for the board",
    "short form agreement",
    "summary of findings report",
  ])("leaves %s alone, because that is what was asked about", (q) => {
    expect(stripOutputInstruction(q)).toBe(q);
  });

  /* Stripping must never empty the query. An empty search is worse than a
     literal one: it matches everything, or it errors. */
  it("keeps the original when stripping would leave nothing", () => {
    expect(stripOutputInstruction("in two sentences")).toBe("in two sentences");
    expect(stripOutputInstruction("briefly")).toBe("briefly");
  });

  it("handles both shapes in one question", () => {
    expect(stripOutputInstruction("the payment schedule briefly in two sentences")).toBe(
      "the payment schedule",
    );
  });
});
