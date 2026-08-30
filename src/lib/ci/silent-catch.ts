/**
 * A catch that says nothing turns a failure into an absence.
 *
 * WHAT IT COST. Chasing why four questions returned no answer, five
 * hypotheses were tested and discarded over an afternoon: an embedding gap, a
 * retrieval threshold, a vocabulary mismatch, a model regression, a bad eval.
 * All wrong. The retrieval had thrown, a catch had returned an empty array,
 * and every layer above it correctly reported "nothing found" because that is
 * genuinely what it received.
 *
 * The system was not broken in a way anything could see. It was broken in the
 * one way nothing can see: the evidence was destroyed at the point of failure,
 * so every downstream signal was honest and useless.
 *
 * This is the same defect the product spends its life designing against, in
 * the code rather than in the copy. An outage and a quiet week read alike. A
 * missing document and an unreadable one read alike. A thrown query and an
 * empty result read alike, and that last one is written by hand, one `catch`
 * at a time.
 *
 * WHAT COUNTS AS SAYING SOMETHING. Any of: logging it, recording a degradation
 * or analytics signal, rethrowing, or an explicit marker with a reason. The
 * bar is deliberately low, because the goal is not ceremony. It is that
 * SOMEWHERE a person can find out this happened.
 *
 * A RATCHET, NOT A WALL. There are dozens of these already and failing the
 * build on all of them would mean turning the check off within a day. The
 * count may fall and may not rise.
 */

export interface CatchSite {
  file: string;
  line: number;
  /** The catch body, for classification and for showing a person. */
  body: string;
}

export type CatchVerdict =
  | { site: CatchSite; state: "reports" }
  /** Marked benign in the source, with a reason. */
  | { site: CatchSite; state: "declared"; reason: string }
  | { site: CatchSite; state: "silent" };

/**
 * Ways of saying a failure happened.
 *
 * Names from this repository rather than invented: the degradation recorder,
 * the analytics call, the audit log, the probe persistence. A check that
 * looked for the wrong names would report working code as silent and get
 * turned off.
 */
const REPORTS =
  /console\.(warn|error|log|info)|trackEvent|recordDegradation|TurnDegradation|noteDegradation|persistProbeResult|writeAudit|captureException|reportError|logger\.|throw\b|degrad/;

/**
 * The marker that declares a catch deliberately quiet.
 *
 * A reason is REQUIRED and is not decoration. "silent-ok" alone would be a
 * mute button, and a mute button gets pressed. Writing why forces the question
 * of whether it is actually fine, which is the entire value of the marker.
 *
 * The first character cannot be a star or a slash, or the comment's own
 * closing delimiter reads as the reason and every unexplained marker passes.
 * Caught by a test, which is the only reason this line is right.
 */
const DECLARED = /silent-ok:\s*([^\s*/][^\n*]*)/;

/**
 * Find catch blocks, with their bodies.
 *
 * Brace-matched rather than line-matched, because a catch body spanning eight
 * lines with a nested object literal is exactly the kind that hides something.
 * Strings and comments are skipped so a brace inside either cannot end a block
 * early.
 */
export function findCatchSites(file: string, source: string): CatchSite[] {
  const sites: CatchSite[] = [];
  const re = /\bcatch\b\s*(?:\([^)]*\))?\s*\{/g;

  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(source, open);
    if (close < 0) continue;
    sites.push({
      file,
      line: source.slice(0, m.index).split("\n").length,
      body: source.slice(open + 1, close),
    });
  }
  return sites;
}

/** Index of the brace closing the one at `open`, or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    /* Skip anything a brace could hide inside. */
    if (c === "/" && s[i + 1] === "/") {
      i = s.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(s, i, c);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function endOfString(s: string, start: number, quote: string): number {
  for (let i = start + 1; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === quote) return i;
    /* An unterminated single-quoted string on one line is a parse we should
       not guess at; bail rather than run to the end of the file. */
    if (quote !== "`" && s[i] === "\n") return -1;
  }
  return -1;
}

export function classify(site: CatchSite): CatchVerdict {
  const declared = DECLARED.exec(site.body);
  if (declared) return { site, state: "declared", reason: declared[1].trim() };
  if (REPORTS.test(site.body)) return { site, state: "reports" };
  return { site, state: "silent" };
}

export interface CatchReading {
  verdicts: CatchVerdict[];
  silent: CatchVerdict[];
  declared: CatchVerdict[];
  reports: CatchVerdict[];
}

export function readCatches(files: { path: string; source: string }[]): CatchReading {
  const verdicts = files.flatMap((f) => findCatchSites(f.path, f.source)).map(classify);
  return {
    verdicts,
    silent: verdicts.filter((v) => v.state === "silent"),
    declared: verdicts.filter((v) => v.state === "declared"),
    reports: verdicts.filter((v) => v.state === "reports"),
  };
}
