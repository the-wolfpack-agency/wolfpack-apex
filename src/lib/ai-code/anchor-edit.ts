/**
 * Anchor edits - the third authoring mode, for editing LARGE existing files the
 * other two modes can't.
 *
 *   files mode: emit the WHOLE new file. Impossible for a 68KB page (can't fetch
 *               it into the 24KB context budget, can't reliably reproduce it).
 *   diff mode:  unified diff. Cheap models garble the line math / hunk counts.
 *
 * Anchor mode: the author emits exact SEARCH/REPLACE blocks - "find this text,
 * put that there" - which needs only the relevant region, has no line numbers to
 * get wrong, and applies DETERMINISTICALLY: the SEARCH must match the live file
 * exactly ONCE, or the edit is a failure that escalates. A wrong anchor can never
 * produce a bad edit - it produces no edit. The applied result is full-file
 * content, so it reuses the existing FileChange commit + gate + CI path unchanged.
 *
 * Format (per file, repeatable):
 *   EDIT path/to/file.ts
 *   <<<<<<< SEARCH
 *   exact existing text
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE
 */
import type { FileChange } from "./file-changes";

export interface AnchorEdit {
  path: string;
  search: string;
  replace: string;
}

export interface AnchorFailure {
  path: string;
  reason: "file_not_provided" | "anchor_not_found" | "anchor_ambiguous" | "empty_search";
}

export interface AnchorApplyResult {
  /** Full-file changes to commit (one per file actually modified). */
  changes: FileChange[];
  /** Edits that could not be applied - these ESCALATE; we never guess. */
  failures: AnchorFailure[];
  /** Count of edits applied cleanly. */
  appliedCount: number;
}

const START = "<<<<<<< SEARCH";
const MID = "=======";
const END = ">>>>>>> REPLACE";

/** Parse the author reply into anchor edits. Robust to surrounding prose/fences. */
export function parseAnchorEdits(reply: string): AnchorEdit[] {
  const lines = reply.split("\n");
  const edits: AnchorEdit[] = [];
  let path: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const editMatch = /^\s*EDIT\s+(.+?)\s*$/.exec(line);
    if (editMatch) {
      path = editMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
      i += 1;
      continue;
    }
    if (line.trim() === START && path) {
      const search: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== MID) { search.push(lines[i]); i += 1; }
      if (i >= lines.length) break; // malformed: no mid marker
      i += 1; // skip MID
      const replace: string[] = [];
      while (i < lines.length && lines[i].trim() !== END) { replace.push(lines[i]); i += 1; }
      if (i >= lines.length) break; // malformed: no end marker
      i += 1; // skip END
      edits.push({ path, search: search.join("\n"), replace: replace.join("\n") });
      continue;
    }
    i += 1;
  }
  return edits;
}

/**
 * Apply anchor edits to the provided file contents. Deterministic + safe: each
 * SEARCH must appear EXACTLY ONCE in the (progressively updated) file, or the edit
 * fails and is reported (never applied as a guess). Edits to the same file apply in
 * order. Returns full-file changes for the existing commit path.
 */
/**
 * Feedback for a tier-escalation retry when SEARCH blocks did not match the live
 * file. The cheaper model could not reproduce the exact spans; a stronger model
 * gets this exact reason so it copies them verbatim instead of paraphrasing.
 */
export function anchorFailureFeedback(failures: readonly AnchorFailure[]): string {
  const paths = [...new Set(failures.map((f) => f.path))];
  return (
    `The previous attempt's SEARCH blocks did not match the live file ` +
    `(${failures.length} anchor failure(s) in ${paths.join(", ")}). Every SEARCH block ` +
    `must be copied CHARACTER-FOR-CHARACTER from the current file content shown above ` +
    `- exact indentation, quotes, and punctuation - with enough surrounding lines to be ` +
    `unique. Re-emit the anchor edits using SEARCH text that appears verbatim in the file.`
  );
}

const trimEnd = (s: string): string => s.replace(/\s+$/, "");

/**
 * Find the char range of the UNIQUE contiguous line-span of `content` whose lines
 * equal `search`'s lines after trimming per-line TRAILING whitespace. Returns the
 * {start,end} char offsets (over the original content), "ambiguous" when more than
 * one span matches, or null when none does. Deterministic; never a partial guess.
 */
function uniqueTrailingTrimmedSpan(content: string, search: string): { start: number; end: number } | "ambiguous" | null {
  const fileLines = content.split("\n");
  const searchLines = search.split("\n");
  const n = searchLines.length;
  if (n === 0 || n > fileLines.length) return null;
  const wanted = searchLines.map(trimEnd);
  // Char offset of the start of each file line (line i starts at lineStart[i]).
  const lineStart: number[] = [0];
  for (let i = 0; i < fileLines.length; i++) lineStart.push(lineStart[i] + fileLines[i].length + 1); // +1 for "\n"
  let found: { start: number; end: number } | null = null;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) { if (trimEnd(fileLines[i + j]) !== wanted[j]) { ok = false; break; } }
    if (!ok) continue;
    const start = lineStart[i];
    const end = lineStart[i] + fileLines.slice(i, i + n).join("\n").length; // span covers the n lines, not the trailing newline
    if (found) return "ambiguous";
    found = { start, end };
  }
  return found;
}

export function applyAnchorEdits(files: Readonly<Record<string, string>>, edits: readonly AnchorEdit[]): AnchorApplyResult {
  const working: Record<string, string> = { ...files };
  const failures: AnchorFailure[] = [];
  let appliedCount = 0;

  for (const e of edits) {
    if (e.search.length === 0) { failures.push({ path: e.path, reason: "empty_search" }); continue; }
    const content = working[e.path];
    if (content == null) { failures.push({ path: e.path, reason: "file_not_provided" }); continue; }
    const first = content.indexOf(e.search);
    if (first >= 0) {
      // Exact match (the fast path). Still require it to be unambiguous.
      if (content.indexOf(e.search, first + 1) >= 0) { failures.push({ path: e.path, reason: "anchor_ambiguous" }); continue; }
      working[e.path] = content.slice(0, first) + e.replace + content.slice(first + e.search.length);
      appliedCount += 1;
      continue;
    }
    // Whitespace-tolerant fallback: the dominant anchor_not_found cause on large
    // files is a model reproducing the span with trailing-whitespace / line-ending
    // drift. Match line-by-line ignoring per-line TRAILING whitespace; apply ONLY
    // when exactly one contiguous line-span matches (same exactly-once determinism,
    // never a guess). The REPLACE text is spliced over the ORIGINAL span verbatim.
    const span = uniqueTrailingTrimmedSpan(content, e.search);
    if (span === "ambiguous") { failures.push({ path: e.path, reason: "anchor_ambiguous" }); continue; }
    if (span === null) { failures.push({ path: e.path, reason: "anchor_not_found" }); continue; }
    working[e.path] = content.slice(0, span.start) + e.replace + content.slice(span.end);
    appliedCount += 1;
  }

  const changes: FileChange[] = Object.keys(working)
    .filter((p) => working[p] !== files[p])
    .map((p) => ({ path: p, content: working[p] }));

  return { changes, failures, appliedCount };
}
