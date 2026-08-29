/**
 * The relevance judge must be shown enough to find the answer.
 *
 * It was handed the first 500 characters of each retrieved chunk. Measured
 * against the real corpus 2026-08-29, the median chunk is 2,262 characters and
 * the longest 2,627, so the judge saw roughly the first fifth of each document:
 * headers, titles, boilerplate.
 *
 * On the chunk holding the answer to "how much do we owe upfront?":
 *
 *   chunk length   2,589 characters
 *   "30 days" at   position 741     -> outside the window
 *   "50%" at       position 2,101   -> outside the window
 *
 * Both figures were invisible to it. The judge ruled IRRELEVANT on what it had
 * been shown — correctly — and tryBrain discarded the retrieval.
 * gateUngroundedClaimAboutUs reads an empty context as "nothing was retrieved"
 * and rejects, so the reader got "I don't have a confident answer" for a
 * question the corpus answers in a line. It fired 123 times in four days.
 *
 * Six hypotheses died before this one: the semantic score floor, the query
 * phrasing, whether semantic ran at all, an unguarded analytics await, a
 * swallowed exception, and search claiming the wrong intent. The cause was a
 * 500-character window.
 */
import {
  RELEVANCE_MATERIAL_PER_HIT,
  RELEVANCE_MATERIAL_MAX,
  buildRelevancePrompt,
} from "@/lib/brain/relevance";

/* Measured from brain_chunks on 2026-08-29. If the corpus shifts, these are the
   numbers the window was sized against. */
const MEDIAN_CHUNK_CHARS = 2262;
const LONGEST_CHUNK_CHARS = 2627;

describe("the judge sees enough of each chunk", () => {
  /* THE REGRESSION. 500 could not show a median chunk, so the judge was ruling
     on the top fifth of a document. */
  it("shows at least a whole median chunk", () => {
    expect(RELEVANCE_MATERIAL_PER_HIT).toBeGreaterThanOrEqual(MEDIAN_CHUNK_CHARS);
  });

  it("comes close to the longest chunk in the corpus", () => {
    expect(RELEVANCE_MATERIAL_PER_HIT).toBeGreaterThan(LONGEST_CHUNK_CHARS * 0.9);
  });

  /* THE EXACT FAILURE. Both figures that answer the question sat past 500. */
  it.each([
    ["30 days", 741],
    ["50%", 2101],
  ])("would now show %s, which sits at character %i", (_needle, position) => {
    expect(RELEVANCE_MATERIAL_PER_HIT).toBeGreaterThan(position);
  });

  /* TWO NUMBERS IS HOW ONE SILENTLY CLIPS THE OTHER. The caller slices per hit
     and this function slices the total; if the total were smaller, the material
     would be truncated a second time and the fix would be invisible. */
  it("has a total budget that cannot clip three full hits", () => {
    expect(RELEVANCE_MATERIAL_MAX).toBeGreaterThanOrEqual(RELEVANCE_MATERIAL_PER_HIT * 3);
  });

  it("does not truncate three full-size hits in the prompt", () => {
    const hit = "x".repeat(RELEVANCE_MATERIAL_PER_HIT);
    const material = [hit, hit, hit].join("\n\n");
    const prompt = buildRelevancePrompt("how much do we owe upfront?", material);
    /* Every hit is represented. Asserted as "at least", not exactly: the
       fencing contributes its own characters, and the claim is that nothing
       was truncated rather than that the string is a precise length. */
    const carried = (prompt.match(/x/g) ?? []).length;
    expect(carried).toBeGreaterThanOrEqual(RELEVANCE_MATERIAL_PER_HIT * 3);
  });

  /* Still bounded. The judge is a cheap-tier call and an unbounded prompt would
     make the cheapest layer the most expensive one. */
  it("stays bounded", () => {
    const huge = "y".repeat(100_000);
    const prompt = buildRelevancePrompt("q", huge);
    const carried = (prompt.match(/y/g) ?? []).length;
    expect(carried).toBeLessThanOrEqual(RELEVANCE_MATERIAL_MAX + 8);
    /* And it really did cut something: 100,000 characters did not go through. */
    expect(carried).toBeLessThan(10_000);
  });

  it("still carries the question", () => {
    expect(buildRelevancePrompt("how much do we owe upfront?", "material")).toContain(
      "how much do we owe upfront?",
    );
  });
});
