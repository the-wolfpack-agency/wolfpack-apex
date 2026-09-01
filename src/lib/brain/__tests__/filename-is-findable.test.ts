/**
 * Naming a document has to find it.
 *
 * `bc.tsv` is built from chunk CONTENT. The filename was selected for display
 * and never matched against, so a document could not be retrieved by its name.
 * Asked for "the viaPeople work order" the Brain returned CIC Training Print, a
 * ScottLeder receipt and a survey export, with the viaPeople work order — which
 * is indexed — nowhere in the results.
 *
 * That is the first thing anybody does after being shown a list and asked which
 * one they meant, so it also made the clarify path a dead end: it asked a
 * question whose answer did not work.
 *
 * AND MATCHING WAS NOT ENOUGH. Once filenames were searchable, the match scored
 * 0.10000 while semantic hits on the same query scored 0.42 to 0.45, so the
 * exact match on the named document stayed buried. The two numbers were never
 * comparable — lexical density over a short string against cosine distance in
 * embedding space — so parity between them is meaningless.
 *
 * These are the numbers that decision rests on, kept where somebody can argue
 * with them.
 */
import { FILENAME_MATCH_WEIGHT } from "@/lib/brain/repo";

/* Measured against the real index on 2026-08-29. */
const RAW_FILENAME_RANK = 0.1;
const TYPICAL_SEMANTIC_SCORE = 0.45;

describe("a named document outranks a topical resemblance", () => {
  it("lifts a filename match above a semantic one", () => {
    expect(RAW_FILENAME_RANK * FILENAME_MATCH_WEIGHT).toBeGreaterThan(TYPICAL_SEMANTIC_SCORE);
  });

  /* Not unbounded. A weight that could exceed a perfect match would make every
     filename hit look like certainty. */
  it("cannot exceed a perfect score once capped", () => {
    expect(Math.min(1, RAW_FILENAME_RANK * FILENAME_MATCH_WEIGHT)).toBeLessThanOrEqual(1);
  });

  /* The weight is a judgment about evidence, not a measurement, and it should
     stay in a range somebody can defend rather than drifting upward whenever a
     query misses. */
  it("stays within a defensible range", () => {
    expect(FILENAME_MATCH_WEIGHT).toBeGreaterThan(4);
    expect(FILENAME_MATCH_WEIGHT).toBeLessThan(20);
  });

  /* It is a match requirement, not a free boost: no filename match, no
     contribution. Zero times anything is still zero. */
  it("contributes nothing when the filename does not match", () => {
    expect(0 * FILENAME_MATCH_WEIGHT).toBe(0);
  });
});
