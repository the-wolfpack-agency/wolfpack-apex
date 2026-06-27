/**
 * Static source detectors for the platform-scan static modality.
 *
 * WHY LINE-BASED, NOT AST: every bug class below is a *regular* textual
 * pattern (a fetch call near a .json() with no guard; a "use client" file with
 * a raw /api fetch; a process.env.DEALER_ID reference). Detecting these does
 * not need type resolution or scope analysis, only local windowed line
 * scanning. A real AST parser (@babel/parser, typescript compiler API as a
 * runtime dep) is a heavy runtime dependency, and this repo forbids new runtime
 * deps without justification. Regex/line scanning is sufficient, zero-dep, and
 * fast. We accept that line scanning can have edge-case false positives/negatives;
 * each detector therefore guards conservatively against the obvious ones.
 *
 * Each detector returns ScanFinding[] with route = file.path and evidence
 * { line, snippet } pointing at the offending source line.
 */

import type { ScanFinding } from "@/lib/platform-scan/types";

interface SourceFile {
  path: string;
  content: string;
}

const FETCH_OPEN = /\bfetch\s*\(/;
const CONSUME = /\.(json|text)\s*\(/;
// A response is NOT silently consumed as data when the code checks ok/status,
// reads it as headers/blob/text, or branches on `if (!...)`. (Reading headers /
// blob / text means the caller deliberately handles the raw response, e.g. an
// auth route reading set-cookie, not the .json()-as-data silent-blank pattern.)
const GUARD = /(\.ok\b|\.status\b|res\.ok|response\.ok|\.headers\b|\.blob\s*\(|\.text\s*\(|if\s*\(\s*!)/;

/**
 * silentFetch: a fetch(...) whose response is consumed via .json()/.text()
 * within the next ~6 lines WITHOUT any ok/status guard in that window. This is
 * the silent-blank-page class (the April-16 incident): a non-2xx body is parsed
 * as if it were data, and the page renders empty.
 */
export function silentFetch(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  // 12 lines: a multi-line POST fetch (method + headers + body object) can push
  // the `.json()` and its `if (!res.ok)` guard well past the fetch line; a 6-line
  // window missed the guard and false-flagged guarded calls. 12 covers the common
  // fetch->guard->json span without reaching into an unrelated later statement.
  const WINDOW = 12;

  for (let i = 0; i < lines.length; i++) {
    if (!FETCH_OPEN.test(lines[i])) continue;

    // Examine the fetch line plus the next WINDOW lines.
    const end = Math.min(lines.length, i + 1 + WINDOW);
    const window = lines.slice(i, end);

    const consumeIdx = window.findIndex((l) => CONSUME.test(l));
    if (consumeIdx === -1) continue;

    // Guard search window is the UNION of two spans, so it never covers less
    // than before: the original fetch+WINDOW span, AND 2 lines past the
    // consumption line. The latter recognizes the common safe idiom
    // `const data = await res.json(); if (!res.ok) {...}` (read the body first to
    // surface the error message, then check ok on the next line) even when a long
    // request body pushes that pair to the edge of the fetch window. Taking the
    // max keeps every guard the fetch+WINDOW span already caught.
    const guardEnd = Math.min(lines.length, Math.max(i + 1 + WINDOW, i + consumeIdx + 3));
    const guardText = lines.slice(i, guardEnd).join("\n");
    if (GUARD.test(guardText)) continue;

    findings.push({
      route: file.path,
      severity: "high",
      category: "bug",
      title: "fetch result used without an ok/status check",
      detail:
        "A fetch response is parsed via .json()/.text() with no .ok/.status guard nearby. " +
        "A non-2xx response body is consumed as data, producing a silent blank page.",
      evidence: { line: i + 1, snippet: lines[i].trim() },
    });
  }

  return findings;
}

// NOTE: a "raw fetch to /api from a client component" detector was removed.
// That was an *apex* convention (all client fetches must use fetchWithRefresh for
// JWT rotation) — it does NOT generalize to an arbitrary client platform with a
// different auth model, and it fired on essentially every client API call (343
// findings on one target, ~all false positives), duplicating silentFetch on the
// lines that are genuine bugs. The universal, real bug — a response consumed
// without an ok/status check — is caught by silentFetch above.

const DEALER_ID = /process\.env\.DEALER_ID\b/;
const COMPONENT_PATH = /(page\.tsx|route\.tsx|components?\/|\.tsx$|\.jsx$)/i;

/**
 * hardcodedTenantId: a process.env.DEALER_ID reference inside a page/component
 * file. Tenant identity must come from the request/session, not a build-time
 * env var; a hardcoded tenant id cross-serves one dealer's data to all.
 */
export function hardcodedTenantId(file: SourceFile): ScanFinding[] {
  if (!COMPONENT_PATH.test(file.path)) return [];

  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DEALER_ID.test(line)) continue;

    findings.push({
      route: file.path,
      severity: "medium",
      category: "security",
      title: "hardcoded tenant id (process.env.DEALER_ID) in a page/component",
      detail:
        "Tenant identity is read from process.env.DEALER_ID in a page/component. " +
        "Tenant id must derive from the authenticated request, not a build-time env var.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }

  return findings;
}

// A catch clause whose body opens on the same line. Captures whatever sits
// between the opening "{" and the end of the line so we can tell an empty body
// ("catch {" / "catch (e) {" / "catch {}" / "catch (e) { }") apart from a body
// that already does something on the same line.
const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{([^}]*)$/;
const SAME_LINE_BRACE_CLOSE = /\bcatch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/;

/**
 * emptyCatch: a catch block whose body is empty (whitespace only) before the
 * closing brace. A swallowed error hides failures from users and logs. We look
 * at the catch line itself: if there is a same-line close (`catch {}` /
 * `catch (e) { }`) we check that inner text is blank; otherwise we scan forward
 * to the first non-blank line and flag if it is the closing brace.
 */
/** An empty catch only matters when it swallows an ASYNC/network error (a silent
 *  failure that blanks a page or drops a write). A trivial empty catch (e.g.
 *  around a JSON.parse or a feature check) is noise. We scope to catches whose
 *  preceding try body (the ~12 lines above) contains an await / fetch / .then. */
const ASYNC_OP = /\b(await\b|fetch\s*\(|\.then\s*\()/;
function swallowsAsync(lines: string[], catchIndex: number): boolean {
  const from = Math.max(0, catchIndex - 12);
  return lines.slice(from, catchIndex + 1).some((l) => ASYNC_OP.test(l));
}

export function emptyCatch(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Case A: catch and its closing brace are on the same line.
    const sameLine = SAME_LINE_BRACE_CLOSE.exec(line);
    if (sameLine) {
      // `catch {} finally { ... }` is the intentional best-effort idiom: the
      // error is deliberately ignored because cleanup runs in finally. Not a bug.
      if (sameLine[1].trim() === "" && !/\}\s*finally\b/.test(line) && swallowsAsync(lines, i)) {
        findings.push(makeEmptyCatchFinding(file, i, line));
      }
      continue;
    }

    // Case B: catch opens a block that continues on following lines.
    const open = EMPTY_CATCH.exec(line);
    if (!open) continue;
    // Anything after the brace on the same line is a statement → not empty.
    if (open[1].trim() !== "") continue;

    // Scan forward to the first non-blank line.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    // Empty body, NOT followed by finally, and wraps an async op.
    if (j < lines.length && lines[j].trim() === "}" && !/^\}\s*finally\b/.test(lines[j + 1]?.trim() ?? "") && swallowsAsync(lines, i)) {
      findings.push(makeEmptyCatchFinding(file, i, line));
    }
  }

  return findings;
}

function makeEmptyCatchFinding(
  file: SourceFile,
  index: number,
  line: string,
): ScanFinding {
  return {
    route: file.path,
    // Low: a code smell, not a high-impact bug — a bare empty catch (no finally
    // cleanup) swallows an error, but many are deliberate best-effort. Surfaced
    // for review, not alarm.
    severity: "low",
    category: "bug",
    title: "error silently swallowed (empty catch)",
    detail:
      "A catch block has an empty body and no finally cleanup, so the error is " +
      "swallowed with no log, no user-facing message, and no rethrow.",
    evidence: { line: index + 1, snippet: line.trim() },
  };
}

// A number input tag. We match a single opening <input ...> tag's text (no
// closing ">" inside) and require type="number" / type={'number'} on it.
const NUMBER_INPUT = /<input\b[^>]*\btype\s*=\s*["'{]?\s*number\b[^>]*>/i;
const HAS_MIN_ATTR = /\bmin\s*=/;

/**
 * unvalidatedNumericInput: a JSX <input type="number"> with no min= attribute
 * on the same tag. Without a range guard the field accepts negative prices,
 * zero terms, and negative down payments. We require the whole opening tag to
 * be on one line (the common case) to avoid multi-line false positives.
 */
export function unvalidatedNumericInput(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = NUMBER_INPUT.exec(line);
    if (!m) continue;
    // Only inspect the matched tag text for the min= guard.
    if (HAS_MIN_ATTR.test(m[0])) continue;

    findings.push({
      route: file.path,
      severity: "medium",
      category: "ux_gap",
      title: "numeric input without a min/range guard (accepts invalid values)",
      detail:
        "A <input type=\"number\"> has no min= attribute, so it accepts negative " +
        "or zero values (negative price, zero term, negative down payment) that " +
        "submit straight through to the backend.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }

  return findings;
}

const DANGEROUS_INNER_HTML = /\bdangerouslySetInnerHTML\b/;

/**
 * dangerousInnerHtml: any use of dangerouslySetInnerHTML — a real XSS surface
 * whenever the HTML is not provably sanitized. We flag every usage so a human
 * confirms the source is trusted/sanitized.
 */
export function dangerousInnerHtml(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DANGEROUS_INNER_HTML.test(line)) continue;
    // The __html value sits on this line or the next couple (object literal).
    const ctx = `${line}\n${lines[i + 1] ?? ""}\n${lines[i + 2] ?? ""}`;
    // JSON.stringify(...) is the standard SAFE JSON-LD / structured-data pattern
    // (serialized data, not markup) — not an XSS vector.
    if (/JSON\.stringify\s*\(/.test(ctx)) continue;
    // A reviewer already vetted this site (audit-safe / eslint-disable comment).
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;

    findings.push({
      route: file.path,
      severity: "high",
      category: "security",
      title: "XSS risk: dangerouslySetInnerHTML",
      detail:
        "dangerouslySetInnerHTML injects raw HTML into the DOM. If the value is " +
        "not provably sanitized, it is a stored/reflected XSS vector.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }

  return findings;
}

// @ts-ignore or @ts-nocheck, but NOT @ts-expect-error (which is checked).
const SUPPRESS_TS = /@ts-(ignore|nocheck)\b/;

/**
 * suppressedTypecheck: a line containing @ts-ignore or @ts-nocheck. These hide
 * real type errors that surface as runtime bugs. @ts-expect-error is excluded —
 * it is intentional and the compiler errors if the suppressed error disappears.
 */
export function suppressedTypecheck(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SUPPRESS_TS.test(line)) continue;

    findings.push({
      route: file.path,
      severity: "medium",
      category: "bug",
      title: "type safety suppressed (@ts-ignore / @ts-nocheck)",
      detail:
        "A @ts-ignore / @ts-nocheck suppresses the type checker on this line. " +
        "Unlike @ts-expect-error it does not fail when the underlying error goes " +
        "away, so it silently hides real type errors that become runtime bugs.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }

  return findings;
}

/** Compose every detector over one file. */
export function runDetectors(file: SourceFile): ScanFinding[] {
  return [
    ...silentFetch(file),
    ...hardcodedTenantId(file),
    ...emptyCatch(file),
    ...unvalidatedNumericInput(file),
    ...dangerousInnerHtml(file),
    ...suppressedTypecheck(file),
  ];
}
