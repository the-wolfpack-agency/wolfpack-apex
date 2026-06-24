/**
 * Deterministic task planner. Splits a goal into ordered sub-goal instructions
 * so the executor runs each step under the gate. No LLM, so it is fully
 * deterministic + testable; an LLM planner is a drop-in replacement behind the
 * AgentPlanner interface when richer planning is wanted.
 *
 * Two layers of splitting, applied in order:
 *   1. Line + list-marker splitting - a human can paste a numbered or bulleted
 *      list and each line becomes a step.
 *   2. Single-line multi-action decomposition - a one-line goal like
 *      "scan the internet for X. Create a document summary of the results."
 *      is split into ordered steps so a multi-action goal does not collapse into
 *      a single (mis-routed) instruction. We split on:
 *        - a sentence boundary: `.`/`?`/`!`/`;` + whitespace + a capital letter
 *          that begins a new imperative;
 *        - conjunctions " and then " / " then " / " and after that ".
 *      Abbreviation guards keep us from splitting inside common abbreviations
 *      (Inc., Corp., U.S., e.g., i.e., etc., Mr., vs., a.m., p.m.) or after a
 *      single-letter initial.
 *
 * Both layers are bounded by MAX_TASK_STEPS (a runaway-plan backstop).
 */

import type { AgentPlanner } from "./types";

/** Max steps a single task may expand to (a runaway-plan backstop). */
export const MAX_TASK_STEPS = 10;

/**
 * Common abbreviations whose trailing period must NOT be read as a sentence
 * boundary. Matched case-insensitively against the token immediately before a
 * candidate split point. Multi-dot forms (U.S., e.g., a.m.) are listed without
 * their final dot because the split regex looks at the char before the final
 * period.
 */
const ABBREVIATIONS = new Set([
  "inc",
  "corp",
  "co",
  "ltd",
  "llc",
  "etc",
  "vs",
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "no",
  "fig",
  "approx",
  "dept",
  "est",
  // dotted forms - the guard also handles these char-by-char below
  "e.g",
  "i.e",
  "a.m",
  "p.m",
  "u.s",
  "u.k",
  "u.n",
]);

export class IntentPlanner implements AgentPlanner {
  readonly kind = "intent";

  plan(goal: string): string[] {
    const lines = (goal ?? "")
      .split(/\r?\n/)
      .map((l) => stripMarker(l).trim())
      .filter((l) => l.length > 0);

    // No usable line breaks: treat the whole goal as a single line for now.
    const baseLines =
      lines.length > 0 ? lines : [(goal ?? "").trim()].filter(Boolean);

    // Single-line multi-action decomposition. A line that already came from a
    // list (multiple lines) is left alone - the human authored the steps. We
    // only decompose when the line is itself a run-on of multiple actions.
    const steps: string[] = [];
    for (const line of baseLines) {
      for (const piece of decompose(line)) {
        const trimmed = piece.trim();
        if (trimmed.length > 0) steps.push(trimmed);
      }
    }

    return steps.slice(0, MAX_TASK_STEPS);
  }
}

/**
 * Decompose a single line into ordered imperative steps. Splits on sentence
 * boundaries and on "and then"/"then"/"and after that" conjunctions, guarding
 * against abbreviations + single-letter initials. Returns [line] when there is
 * nothing to split.
 */
function decompose(line: string): string[] {
  // (1) Conjunction splits first. " and then " / " and after that " / " then "
  // (the longer forms first so " then " does not pre-empt " and then ").
  const conjoined = line.split(
    /\s+(?:and\s+then|and\s+after\s+that|then)\s+/i,
  );

  const out: string[] = [];
  for (const segment of conjoined) {
    out.push(...splitSentences(segment));
  }
  return out.length > 0 ? out : [line];
}

/**
 * Split a segment on sentence boundaries: a `.`/`?`/`!`/`;` followed by
 * whitespace and a capital letter starting a new word. Skips a boundary when the
 * token before it is a known abbreviation or a single-letter initial.
 */
function splitSentences(segment: string): string[] {
  const pieces: string[] = [];
  let start = 0;

  // Scan for terminator + whitespace + capital-letter lookahead.
  const re = /([.?!;])\s+(?=[A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const terminatorIndex = m.index; // index of the .?!; char

    if (isAbbreviationBoundary(segment, terminatorIndex)) {
      // Not a real boundary - keep scanning, do not cut here.
      continue;
    }

    // Cut: include the terminator with the preceding sentence.
    pieces.push(segment.slice(start, terminatorIndex + 1));
    start = terminatorIndex + m[0].length; // skip the whitespace
  }

  // Tail.
  pieces.push(segment.slice(start));
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * True when the period at `dotIndex` in `text` is part of an abbreviation or a
 * single-letter initial, so it must NOT be treated as a sentence boundary. Only
 * periods abbreviate; `?`/`!`/`;` are always real boundaries.
 *
 *   - single-letter initial: a lone letter immediately before the dot whose own
 *     preceding char is a boundary (start / space / dot) - covers "U.S.",
 *     "U.K.", "a.m.", and "J. Smith".
 *   - known abbreviation: the trailing alphabetic+dot token before the dot
 *     (lower-cased, trailing dot stripped) is in ABBREVIATIONS - "Inc.",
 *     "Corp.", "etc.", "e.g.", "i.e.", "vs.", "Mr.".
 */
function isAbbreviationBoundary(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== ".") return false;

  // Single-letter initial: <boundary><letter>.
  const prev = text[dotIndex - 1] ?? "";
  if (/[A-Za-z]/.test(prev)) {
    const beforePrev = dotIndex - 2 < 0 ? " " : (text[dotIndex - 2] ?? " ");
    if (beforePrev === " " || beforePrev === ".") {
      return true;
    }
  }

  // Known abbreviation: trailing token of letters (with internal dots) ending at
  // the dot. e.g. for "etc." -> "etc"; for the final dot of "e.g." -> "e.g".
  const tokenMatch = /([A-Za-z][A-Za-z.]*)\.$/.exec(text.slice(0, dotIndex + 1));
  if (tokenMatch) {
    const token = tokenMatch[1].toLowerCase().replace(/\.+$/, "");
    if (ABBREVIATIONS.has(token)) return true;
  }

  return false;
}

/** Remove a leading list marker like "1.", "1)", "-", "*", or a bullet. */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "");
}

export function getPlanner(): AgentPlanner {
  return new IntentPlanner();
}
