/**
 * The corpus boundary: what may be quoted at somebody asking about their work.
 *
 * Measured 2026-08-27. Of the 795 answerable documents in the Brain, 744 were
 * written by the demo seeder (633) or by the platform scanner writing its own
 * findings back in (438 across both counts). Fifty-one are real, thirty-three
 * of those a single chunk, and eleven came from SharePoint.
 *
 * So the assistant has been running keyword search over a corpus that is
 * ninety-four percent synthetic and citing it. That is not a routing problem
 * or a prompt problem. Both were fixed this week and the answers stayed wrong,
 * because the corpus was never the thing being fixed.
 */

import {
  NON_CORPUS_UPLOADERS,
  NON_CORPUS_UPLOADER_IDS,
  isClientCorpus,
  nonCorpusExclusionSql,
} from "@/lib/brain/corpus";

describe("what counts as somebody's own content", () => {
  it("excludes the demo seeder and the scanner", () => {
    expect(isClientCorpus("demo-cto")).toBe(false);
    expect(isClientCorpus("platform-scan")).toBe(false);
  });

  it("keeps a real person's upload", () => {
    expect(isClientCorpus("bef8a32d-da1f-4292-beed-a4707bfe43dd")).toBe(true);
  });

  it("keeps a document that came from the client's own drive, whoever ran the sync", () => {
    /* THE BUG THIS FILE SHIPPED. The SharePoint sync of 2026-05-16 ran under
       the demo-cto user id, so 275 genuine client documents were attributed to
       the demo seeder and excluded from retrieval: a strategy deck, the BA101
       and BA102 training days, the material somebody would ask about first.
       "Who ran the sync" is not "is this real content". */
    expect(isClientCorpus("demo-cto", "drive-item-123")).toBe(true);
    expect(isClientCorpus("platform-scan", "drive-item-123")).toBe(true);
  });

  it("still excludes a synthetic document that came from nowhere", () => {
    /* Provenance only rescues documents that actually have it. A fixture with
       no drive item is still a fixture. */
    expect(isClientCorpus("demo-cto", null)).toBe(false);
    expect(isClientCorpus("platform-scan", undefined)).toBe(false);
  });

  it("keeps a document whose uploader is unknown", () => {
    /* Unknown provenance is not the same claim as known-synthetic. Dropping it
       would hide real documents to be tidy, which is the more expensive
       mistake: a missing answer looks like the product cannot help. */
    expect(isClientCorpus(null)).toBe(true);
    expect(isClientCorpus(undefined)).toBe(true);
    expect(isClientCorpus("")).toBe(true);
  });

  it("every exclusion says why, in enough words to argue with", () => {
    /* A list of banned uploaders with no reasons becomes permanent. */
    for (const u of NON_CORPUS_UPLOADERS) {
      expect(u.why.length).toBeGreaterThan(30);
    }
  });

  it("is a short list, because it is meant to shrink to nothing", () => {
    /* Every entry is a producer that should eventually write somewhere other
       than the client's document library. If this grows, the fix is to stop
       the writing, not to lengthen the list. */
    expect(NON_CORPUS_UPLOADER_IDS.length).toBeLessThanOrEqual(4);
  });
});

describe("the SQL predicate", () => {
  it("binds the parameter index it is given, so it composes", () => {
    expect(nonCorpusExclusionSql(4)).toContain("$4");
    expect(nonCorpusExclusionSql(1, "d")).toContain("d.uploaded_by");
  });

  it("lets a drive-sourced document through whatever the uploader", () => {
    /* The predicate and the helper must agree, or documents go missing from
       search and nowhere else says why. */
    expect(nonCorpusExclusionSql(2)).toMatch(/ms_drive_item_id IS NOT NULL/);
  });

  it("lets a NULL uploader through, matching isClientCorpus", () => {
    /* The two must agree. A predicate that drops NULLs while the helper keeps
       them is the kind of split that shows up as documents mysteriously
       missing from search and nowhere else. */
    expect(nonCorpusExclusionSql(2)).toMatch(/IS NULL/);
  });
});
