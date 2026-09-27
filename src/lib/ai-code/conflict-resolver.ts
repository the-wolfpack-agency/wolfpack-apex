/**
 * Automatic conflict resolution for the factory's own PRs.
 *
 * The factory's changes go stale when the base branch moves, and because most of
 * what it generates is ADDITIVE (a new function, a new import, an appended test
 * block), the conflicts are usually keep-both: two independent additions git
 * could not order. A human had to resolve those by hand (PR #910). This resolves
 * the safe cases automatically and, crucially, is SAFE BY DEFAULT: anything that
 * is not a clean additive/one-sided conflict is left unresolved and escalated,
 * and every auto-resolved result is still re-run through the gate + build, so a
 * wrong guess fails CI rather than merging.
 *
 * Pure: parses conflict-marked content (2-way or diff3) and returns the resolved
 * text plus a per-hunk classification. No git, no IO.
 */

export type ConflictHunkKind = "ours-only" | "theirs-only" | "keep-both" | "semantic";

export interface ConflictResolution {
  /** Resolved content when every hunk was auto-resolvable, else null. */
  resolved: string | null;
  /** True when there were no semantic conflicts (every hunk resolved). */
  autoResolvable: boolean;
  /** Whether any conflict markers were present at all. */
  hadConflicts: boolean;
  /** One entry per conflict hunk, in order. */
  hunks: { kind: ConflictHunkKind }[];
}

const START = /^<{7}(\s|$)/;
const BASE = /^\|{7}(\s|$)/;
const SEP = /^={7}(\s|$)/;
const END = /^>{7}(\s|$)/;

/** The "identity" of a line: the thing being defined or assigned, i.e. the text
 *  before the first =, :, or ( . So `const timeout = 30;` and `const timeout =
 *  60;` share the key `const timeout` (the SAME thing, edited differently -> a
 *  real conflict), while `function foo()` and `function bar()` do not (two
 *  different definitions -> independent additions). */
function keyOf(line: string): string {
  const t = line.trim();
  let idx = -1;
  for (const ch of ["=", ":", "("]) {
    const k = t.indexOf(ch);
    if (k !== -1 && (idx === -1 || k < idx)) idx = k;
  }
  return (idx === -1 ? t : t.slice(0, idx)).trim();
}

/** Line keys that carry real meaning. Structural-only lines (braces, brackets,
 *  parens, semicolons, commas) and blanks are ignored, so two independent
 *  additions that merely both end in "}" are still seen as disjoint. */
function significantKeys(block: string): Set<string> {
  const out = new Set<string>();
  for (const raw of block.split("\n")) {
    const t = raw.trim();
    if (t === "") continue;
    if (/^[{}()[\];,]+$/.test(t)) continue;
    const key = keyOf(t);
    if (key !== "") out.add(key);
  }
  return out;
}

/** Two sides are disjoint (a safe keep-both) when they define/assign no common
 *  key. A shared key means the SAME thing was edited on both sides, which is a
 *  semantic conflict we must never auto-resolve. Over-conservative on purpose:
 *  when unsure it escalates rather than guesses, and the result is re-gated. */
function disjoint(a: string, b: string): boolean {
  const sa = significantKeys(a);
  if (sa.size === 0) return true;
  const sb = significantKeys(b);
  if (sb.size === 0) return true;
  for (const k of sa) if (sb.has(k)) return false;
  return true;
}

/** Resolve one hunk's ours/theirs into text, or null when it is semantic. */
function resolveHunk(ours: string, theirs: string): { kind: ConflictHunkKind; text: string | null } {
  if (ours.trim() === "") return { kind: "theirs-only", text: theirs };
  if (theirs.trim() === "") return { kind: "ours-only", text: ours };
  if (disjoint(ours, theirs)) {
    // Keep both, ours first, preserving each side verbatim.
    const joiner = ours.endsWith("\n") || ours === "" ? "" : "\n";
    return { kind: "keep-both", text: ours + joiner + theirs };
  }
  return { kind: "semantic", text: null };
}

export function resolveConflicts(content: string): ConflictResolution {
  const lines = content.split("\n");
  const hunks: { kind: ConflictHunkKind }[] = [];
  const out: string[] = [];
  let hadConflicts = false;
  let autoResolvable = true;

  let i = 0;
  while (i < lines.length) {
    if (!START.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // Enter a conflict hunk.
    hadConflicts = true;
    i++; // skip <<<<<<<
    const oursLines: string[] = [];
    while (i < lines.length && !BASE.test(lines[i]) && !SEP.test(lines[i])) oursLines.push(lines[i++]);
    // Optional diff3 base section: consume and ignore it.
    if (i < lines.length && BASE.test(lines[i])) {
      i++; // skip |||||||
      while (i < lines.length && !SEP.test(lines[i])) i++;
    }
    if (i < lines.length && SEP.test(lines[i])) i++; // skip =======
    const theirsLines: string[] = [];
    while (i < lines.length && !END.test(lines[i])) theirsLines.push(lines[i++]);
    if (i < lines.length && END.test(lines[i])) i++; // skip >>>>>>>

    const { kind, text } = resolveHunk(oursLines.join("\n"), theirsLines.join("\n"));
    hunks.push({ kind });
    if (text === null) {
      autoResolvable = false;
      // Leave a marker-free but clearly-unresolved placeholder is unsafe; instead
      // we simply do not emit resolved content (resolved stays null below).
    } else if (text !== "") {
      out.push(text);
    }
  }

  return {
    resolved: hadConflicts && autoResolvable ? out.join("\n") : hadConflicts ? null : content,
    autoResolvable: !hadConflicts ? true : autoResolvable,
    hadConflicts,
    hunks,
  };
}
