/**
 * What counts as the client's corpus, and what is the product's own exhaust.
 *
 * MEASURED 2026-08-27. The Brain holds 1,127 documents and 795 are answerable.
 * Of those 795, SEVEN HUNDRED AND FORTY FOUR were not put there by anybody
 * using the product:
 *
 *   demo-cto        633   seed fixtures from the demo workspace
 *   platform-scan   438   the scanner writing its own findings back in
 *
 * Fifty-one documents are real, and thirty-three of those are a single chunk.
 * Eleven came from SharePoint.
 *
 * So when somebody asks the assistant a question, keyword search runs over a
 * corpus that is ninety-four percent demo fixtures and scan logs, and the
 * answer cites one. That is not a prompt problem or a routing problem, and no
 * amount of either fixes it. It is the corpus.
 *
 * WHY EXCLUDE IN CODE RATHER THAN DELETE THE ROWS. Deleting is irreversible
 * and the demo fixtures have a legitimate use in the demo workspace; the
 * scanner's findings have a legitimate use in the scan surfaces. What is wrong
 * is quoting either back to a person asking a question about their business.
 * A declared exclusion at the retrieval boundary is reversible, reviewable,
 * and cannot destroy anything.
 *
 * MEANT TO SHRINK TO NOTHING. Every entry here is a producer that should
 * eventually write somewhere other than the client's document library.
 */

/** Uploaders whose documents must never be quoted as a client's own. */
export const NON_CORPUS_UPLOADERS: ReadonlyArray<{ uploader: string; why: string }> = [
  {
    uploader: "demo-cto",
    why: "seed fixtures for the demo workspace; 633 documents, none of them anybody's real content",
  },
  {
    uploader: "platform-scan",
    why: "the scanner writing its own findings back into the Brain; 438 documents of the product talking to itself",
  },
];

/** Just the ids, for a SQL parameter. */
export const NON_CORPUS_UPLOADER_IDS: readonly string[] = NON_CORPUS_UPLOADERS.map(
  (u) => u.uploader,
);

/**
 * SQL predicate excluding non-corpus documents.
 *
 * Takes the parameter index so it composes with whatever the caller has
 * already bound. `uploaded_by` is nullable, and a null uploader is NOT
 * excluded: an unknown provenance is not the same claim as a known-synthetic
 * one, and silently dropping it would hide real documents.
 */
export function nonCorpusExclusionSql(paramIndex: number, alias = "bd"): string {
  return `(${alias}.uploaded_by IS NULL OR ${alias}.uploaded_by <> ALL($${paramIndex}))`;
}

/** Whether a document would be quoted to somebody asking about their business. */
export function isClientCorpus(uploadedBy: string | null | undefined): boolean {
  if (!uploadedBy) return true;
  return !NON_CORPUS_UPLOADER_IDS.includes(uploadedBy);
}
