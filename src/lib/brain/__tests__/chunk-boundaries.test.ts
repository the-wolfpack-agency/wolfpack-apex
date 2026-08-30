/**
 * Chunks must not start mid-word, because a reader sees the seam.
 *
 * MEASURED ON THE LIVE CORPUS, 2026-08-30: 509 chunk seams open on a genuine
 * word fragment, which is 70.8 per cent of every seam beginning on a lowercase
 * token. (A first pass reported 1,119 by matching on shape alone, which counts
 * "this agreement..." as damage; comparing the opening token against the chunk
 * it overlaps is the measurement that holds up.) Real examples:
 *
 *   chunk 1  "the Annual Subscription ..."
 *   chunk 2  ", physical, and technica ..."
 *   chunk 6  "tation and Project Manag ..."   <- tail of "Documentation"
 *
 * That last one reached a person. Asking "what are the payment terms in our
 * SOW?" quoted "tation and Project Management fees: 50% ($6,000.00) is due
 * within 30 days", where the figures are exactly right and the answer looks
 * damaged. In a client walkthrough that is worse than being wrong, because it
 * undermines the answers that ARE correct.
 *
 * The cause was `current.slice(-overlapChars)`: the overlap carried between
 * chunks was a raw character slice, landing wherever the arithmetic said. The
 * chunk END was already sentence-aligned; only the start was unguarded.
 *
 * THIS GUARDS NEW INGESTS ONLY. The 509 chunks already stored keep their
 * seams until the corpus is re-ingested, which is why `quote-window.ts` also
 * repairs the display side for text that is already in the database.
 */

import { chunkText } from "@/lib/brain/chunker";

/**
 * A chunk opens mid-word when its first token is not a whole word of the source.
 *
 * Shape alone cannot decide this. An overlap that begins at a real word boundary
 * often begins on a lowercase word ("this agreement. Payment terms...") and is
 * perfectly correct, while "tation" looks the same to a regex. The difference is
 * only visible against the document: "this" appears in it preceded by a space,
 * "tation" appears only inside "Documentation".
 */
function opensMidWord(chunk: string, source: string): boolean {
  const first = chunk.trim().split(/\s+/)[0]?.replace(/[.,;:]+$/, "");
  if (!first) return false;
  return !new RegExp(`(^|\\s)${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(source);
}

/**
 * Long enough to force many overlaps, with multi-syllable words at the seams so
 * a mid-word cut shows up as a fragment rather than as a plausible short word.
 */
function longDocument(sections: number): string {
  const para = (n: number) =>
    `Section ${n}. Documentation and Project Management responsibilities are defined in the ` +
    `Customized Specification Document referenced throughout this agreement. Payment terms, ` +
    `renewal conditions and termination rights are enumerated below with their corresponding ` +
    `schedules and administrative obligations for the subscription period.`;
  return Array.from({ length: sections }, (_, i) => para(i)).join("\n\n");
}

describe("chunk overlap lands on a word boundary", () => {
  it("produces enough chunks for the overlap path to be exercised", () => {
    /* If this document stopped being long enough to split, the assertions
       below would pass by doing nothing. */
    expect(chunkText(longDocument(60)).length).toBeGreaterThan(3);
  });

  it("no chunk opens on a word fragment", () => {
    const source = longDocument(60);
    const heads = chunkText(source)
      .map((c) => c.content.trim())
      .filter((c) => opensMidWord(c, source))
      .map((c) => c.slice(0, 40));

    expect(heads).toEqual([]);
  });

  it("keeps the overlap, because continuity is the point of having one", () => {
    const chunks = chunkText(longDocument(60));
    /* Consecutive chunks must share text. Snapping the boundary forward must
       not become "drop the overlap", which would pass the test above while
       removing the feature. */
    const first = chunks[0].content;
    const second = chunks[1].content;
    const openingOfSecond = second.trim().slice(0, 40);
    expect(first).toContain(openingOfSecond);
  });

  it("leaves a document too short to split completely alone", () => {
    const short = "Payment is due net 30 from the invoice date.";
    const chunks = chunkText(short);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content.trim()).toBe(short);
  });
});
