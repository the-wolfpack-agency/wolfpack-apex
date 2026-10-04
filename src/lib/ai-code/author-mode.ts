/**
 * Pick the authoring mode for a run.
 *
 * Files mode authors a WHOLE file from the prompt - great for a NEW file, but it
 * cannot edit an existing one: it has no live base, so a model asked to edit a
 * 300-line module returns an empty change (422). Diff mode has the same blind
 * spot (no live base). Anchor mode fetches the live file and applies exact
 * SEARCH/REPLACE - the right tool for an edit. So when the task targets a file
 * that already exists AND the caller did not explicitly pin a mode, author via
 * anchor; a NEW-file task keeps its mode.
 *
 * `pinned` = the caller sent an explicit mode. A user who explicitly pins diff or
 * anchor gets exactly that (they know their intent). But the pipeline DEFAULT is
 * "diff" when nothing is sent, and a defaulted diff must NOT dead-end a large
 * existing-file edit at a 422 - the whole "never a cheap-only dead-end" guarantee.
 *
 * Found by dogfooding: editing the factory's own imports.ts 422'd in files mode,
 * and a minimal edit to src/app/(dashboard)/admin/site-analytics/page.tsx 422'd in
 * the defaulted diff mode (the live large-file routing journey).
 */
export function pickAuthorMode(
  requested: "diff" | "files" | "anchor",
  mentionedPaths: readonly string[],
  repoTree: ReadonlySet<string>,
  pinned = true,
): "diff" | "files" | "anchor" {
  const editsExisting = mentionedPaths.some((p) => repoTree.has(p));
  // An explicitly user-pinned diff/anchor is always respected (caller's intent).
  if (pinned && (requested === "diff" || requested === "anchor")) return requested;
  // Otherwise (files mode - which can never edit - OR an unpinned default): an
  // existing-file edit must use anchor; a new-file task keeps its requested mode.
  return editsExisting ? "anchor" : requested;
}
