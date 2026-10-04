/**
 * Factory brain #3: correction analysis - DETERMINISTIC diff-of-diffs. Given what
 * the factory authored and what a human actually merged, compute what the human
 * changed and categorize it, so future authoring of the same task type can be told
 * "humans usually add X here."
 *
 * Pure (no db, no model, no IO). The output is a summary - category labels + line
 * counts - never the delta code, so nothing here can hold a secret.
 */

/** A deterministic category of human correction. */
export type CorrectionCategory =
  | "tests" | "error-handling" | "imports" | "types" | "new-files" | "removed-code" | "comments";

export interface CorrectionAnalysis {
  /** The merged result differs from what the factory authored. */
  edited: boolean;
  categories: CorrectionCategory[];
  /** Normalized added lines present in the merged diff but not the authored one. */
  humanAdded: number;
  /** Normalized added lines the factory authored that the human dropped. */
  humanRemoved: number;
  /** Files the human added/changed beyond what the factory touched. */
  filesTouchedByHuman: number;
}

const TEST_PATH = /(?:\.(?:test|spec)\.[tj]sx?$|(?:^|\/)__tests__\/|(?:^|\/)e2e\/)/i;
const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{)|const\s+\w+\s*=\s*require\()/;
const ERROR_HANDLING = /\b(?:try|catch|finally|throw|\.catch\(|Result<|err(?:or)?\b|reject\()/;
const TYPE_LINE = /\b(?:interface|type)\s+\w|:\s*[A-Z]\w+(?:<|\[|\s|$)/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Parse a unified diff into added lines (trimmed) grouped by the file path. */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!diff) return out;
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // "+++ b/path" (or /dev/null for a delete)
      const p = line.slice(4).replace(/^b\//, "").trim();
      path = p === "/dev/null" ? "" : p;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const body = line.slice(1).trim();
      if (!body) continue; // ignore blank-line additions (formatting noise)
      if (!out.has(path)) out.set(path, []);
      out.get(path)!.push(body);
    }
  }
  return out;
}

function categorize(file: string, humanLines: string[], isNewFile: boolean, removedAny: boolean): Set<CorrectionCategory> {
  const cats = new Set<CorrectionCategory>();
  if (TEST_PATH.test(file)) cats.add("tests");
  if (isNewFile) cats.add("new-files");
  if (removedAny) cats.add("removed-code");
  for (const l of humanLines) {
    if (IMPORT_LINE.test(l)) cats.add("imports");
    if (ERROR_HANDLING.test(l)) cats.add("error-handling");
    if (TYPE_LINE.test(l)) cats.add("types");
    if (COMMENT_LINE.test(l)) cats.add("comments");
  }
  return cats;
}

/**
 * Compare the factory's authored diff to the merged diff and summarize the human
 * correction. The merged diff (base..head) is a superset when the human only
 * added; a line the factory authored but absent from the merged diff was dropped.
 * Whitespace-only differences are ignored (lines are trimmed, blanks skipped).
 */
export function analyzeCorrection(authoredDiff: string, mergedDiff: string): CorrectionAnalysis {
  const authored = addedLinesByFile(authoredDiff);
  const merged = addedLinesByFile(mergedDiff);
  const cats = new Set<CorrectionCategory>();
  let humanAdded = 0;
  let humanRemoved = 0;
  const humanFiles = new Set<string>();

  // Human ADDITIONS: a merged file/line the factory did not author.
  for (const [file, mLines] of merged) {
    const aSet = new Set(authored.get(file) ?? []);
    const isNewFile = !authored.has(file);
    const extra = mLines.filter((l) => !aSet.has(l));
    if (extra.length === 0 && !isNewFile) continue;
    humanAdded += extra.length;
    if (extra.length > 0 || isNewFile) humanFiles.add(file);
    for (const c of categorize(file, extra, isNewFile, false)) cats.add(c);
  }
  // Human REMOVALS: a line the factory authored that is gone from the merged diff.
  for (const [file, aLines] of authored) {
    const mSet = new Set(merged.get(file) ?? []);
    const dropped = aLines.filter((l) => !mSet.has(l));
    if (dropped.length === 0) continue;
    humanRemoved += dropped.length;
    humanFiles.add(file);
    cats.add("removed-code");
  }

  return {
    edited: humanAdded > 0 || humanRemoved > 0,
    categories: [...cats].sort(),
    humanAdded,
    humanRemoved,
    filesTouchedByHuman: humanFiles.size,
  };
}

/**
 * A short author-prompt grounding block from the dominant correction categories a
 * task type tends to need. Pure. "" when there is nothing useful to say.
 */
export function buildCorrectionBlock(categories: readonly { category: string; rate: number }[]): string {
  const strong = categories.filter((c) => c.rate >= 0.34).slice(0, 4);
  if (!strong.length) return "";
  const advice: Record<string, string> = {
    tests: "include tests",
    "error-handling": "handle errors explicitly (no unguarded throws)",
    imports: "wire up the imports it needs",
    types: "add precise types",
    "new-files": "create the supporting files, not just edit one",
    "removed-code": "keep the change minimal (humans often trim it)",
    comments: "document non-obvious logic",
  };
  const items = strong.map((c) => advice[c.category] ?? c.category);
  return `HUMAN CORRECTIONS (for this kind of task, reviewers frequently had to ${items.join("; ")}). Do these up front so the PR merges as-authored.`;
}
