/**
 * Pick the authoring mode for a run.
 *
 * Files mode authors a WHOLE file from the prompt - great for a NEW file, but it
 * cannot edit an existing one: it has no live base, so a model asked to edit a
 * 300-line module returns an empty change (422). Anchor mode fetches the live
 * file and applies exact SEARCH/REPLACE - the right tool for an edit. So when the
 * task targets a file that already exists, author via anchor; a NEW-file task
 * stays in files mode. A user-pinned anchor/diff is always respected.
 *
 * Found by dogfooding: editing the factory's own imports.ts 422'd in files mode.
 */
export function pickAuthorMode(
  requested: "diff" | "files" | "anchor",
  mentionedPaths: readonly string[],
  repoTree: ReadonlySet<string>,
): "diff" | "files" | "anchor" {
  // Only files mode is auto-redirected; an explicit anchor/diff is the caller's call.
  if (requested !== "files") return requested;
  const editsExisting = mentionedPaths.some((p) => repoTree.has(p));
  return editsExisting ? "anchor" : "files";
}
