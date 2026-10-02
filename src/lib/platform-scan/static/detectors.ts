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
import {
  // The canonical security pattern signatures - defined ONCE in security-corpus
  // and shared with the diff-line gate (ai-code/detect.ts), so the two engines
  // can never drift. Aliased to the local names this module already used.
  EVAL_EXEC as EVAL_CALL,
  DYNAMIC_FUNCTION,
  SQL_KEYWORD,
  SQL_INTERP,
  SQL_PARAMETERIZED as PARAMETERIZED,
  MATH_RANDOM,
  CRED_NAME as SECRET_NAME,
  CRED_CONTEXT,
} from "@/lib/platform-scan/static/security-corpus";

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

/** Best-effort fire-and-forget operations whose failure is INTENTIONALLY ignored:
 *  telemetry / analytics / logging. Wrapping these in `try { ... } catch {}` so a
 *  metrics hiccup never breaks the request is a correct, deliberate idiom, not a
 *  swallowed bug. (This is the dominant empty-catch false positive in real code.) */
const BEST_EFFORT_OP =
  /\b(track\w*|analytics\w*|telemetry|captureException|gtag|posthog|mixpanel|amplitude|datadog|beacon|metric\w*|recordAudit|trackEvent)\s*\(|\b(console|logger)\s*\.\s*\w+\s*\(|rollback|\b(release|abort|disconnect|teardown|dispose|cleanup|revert)\s*\(|audit_log|audit_trail/i;
/** A consequential op whose failure leaves a write/user-state inconsistent: the
 *  case an empty catch genuinely hides. If the try body has one of these, the
 *  catch is NOT mere best-effort even if it also emits telemetry. */
const CONSEQUENTIAL_OP =
  /=\s*await\b(?!\s*import\b)|\breturn\b|\b(save|insert|update|delete|create|write|upsert|commit|send|charge|fetch|mutate|persist|setState|redirect|revalidate)\w*\s*\(/i;

/** True when the try body guarded by this catch is purely best-effort telemetry/
 *  logging (and has no consequential op), so an empty catch around it is the
 *  intended fire-and-forget idiom, not a silently-swallowed failure worth flagging. */
function tryBodyBestEffort(lines: string[], catchIndex: number): boolean {
  // Walk back to the nearest `try` opener (bounded) to bound the body precisely;
  // fall back to the same 12-line window swallowsAsync uses.
  let start = catchIndex;
  for (let k = catchIndex; k >= Math.max(0, catchIndex - 40); k--) {
    if (/\btry\b\s*\{?/.test(lines[k])) { start = k; break; }
    start = Math.max(0, catchIndex - 12);
  }
  const body = lines.slice(start, catchIndex + 1).join("\n");
  return BEST_EFFORT_OP.test(body) && !CONSEQUENTIAL_OP.test(body);
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
      if (
        sameLine[1].trim() === "" &&
        !/\}\s*finally\b/.test(line) &&
        swallowsAsync(lines, i) &&
        !tryBodyBestEffort(lines, i)
      ) {
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
    if (
      j < lines.length &&
      lines[j].trim() === "}" &&
      !/^\}\s*finally\b/.test(lines[j + 1]?.trim() ?? "") &&
      swallowsAsync(lines, i) &&
      !tryBodyBestEffort(lines, i)
    ) {
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

// Provider-specific committed-credential signatures. Each entry is a label +
// the regex whose first whole match IS the secret value (so we can redact it).
// PROVIDER-SIGNATURE secrets only. These are unambiguous, structurally distinct
// token formats: a match is a real credential with near-zero false-positive rate.
// We deliberately do NOT use a generic `name = "literal"` heuristic: on real code
// it fires on placeholders ("SHADOW_MODE_SECRET"), demo seeds ("whsec_demo_..."),
// mocks ("mock-link-token") and display keys, which buries the true positives in
// noise (see the precision discussion). Broader, dataflow-aware secret + taint
// detection (generic high-entropy keys, SQLi, SSRF) is a job for a real SAST
// (Semgrep / gitleaks), recommended as the next tier rather than reimplemented
// imprecisely here.
const SECRET_PROVIDERS: ReadonlyArray<{ provider: string; re: RegExp }> = [
  { provider: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { provider: "Stripe live secret", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}/ },
  { provider: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b/ },
  { provider: "GitHub token", re: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  { provider: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { provider: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { provider: "OpenAI key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { provider: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { provider: "SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { provider: "Twilio account SID", re: /\bAC[0-9a-f]{32}\b/ },
  { provider: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { provider: "Private key (PEM)", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
];

/** Replace the first occurrence of `secret` in `line` with a redaction marker so
 *  we never persist the credential itself in a finding. */
function redact(line: string, secret: string): string {
  return line.replace(secret, "***REDACTED***").trim();
}

/**
 * hardcodedSecret: a committed credential in source, matched ONLY by unambiguous
 * provider token signatures (AWS / Stripe / GitHub / Google / Slack / OpenAI /
 * Anthropic / SendGrid / Twilio / npm / PEM private key). Severity critical. A
 * match is structurally a real key, so the false-positive rate is near zero. The
 * secret value is ALWAYS redacted in the evidence snippet, so scanning for
 * secrets never itself stores one.
 *
 * We intentionally dropped the generic `sensitiveName = "literal"` heuristic: on
 * real code it flagged placeholders, demo seeds and display keys, producing the
 * exact false-positive noise that makes a scanner untrustworthy. Generic /
 * high-entropy secret detection and taint classes (SQLi, SSRF) belong to a
 * dataflow-aware SAST (Semgrep / gitleaks), recommended as the next tier.
 */
export function hardcodedSecret(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A line can carry several distinct providers; flag each once per line.
    const seen = new Set<string>();
    for (const { provider, re } of SECRET_PROVIDERS) {
      const m = re.exec(line);
      if (!m) continue;
      if (seen.has(provider)) continue;
      seen.add(provider);
      findings.push({
        route: file.path,
        severity: "critical",
        category: "security",
        title: `Hardcoded secret (${provider})`,
        detail:
          "A live credential is committed to source. It must be rotated " +
          "immediately (treat it as already leaked) and moved into an env var " +
          "or a secret manager, never stored in the repository.",
        evidence: { line: i + 1, snippet: redact(line, m[0]) },
      });
    }
  }

  return findings;
}

/**
 * Log-call method names across the common loggers (console, a winston/pino
 * instance, a `logger`/`log` object). error/warn are included: a credential is
 * a credential whatever level it is logged at.
 */
const LOG_CALL =
  /(?:\bconsole|\blog(?:ger)?|\bwinston|\bpino|\.log(?:ger)?)\s*\.\s*(?:log|info|debug|warn|error|trace|fatal|verbose|silly)\s*\(/i;

/**
 * Identifier names that carry a credential or a single-use link. Matched as
 * CODE (after string-literal text is stripped by logArgCode), so a log line
 * that merely mentions "token" in prose does not trip it, while a logged
 * variable or interpolation named `token`/`resetUrl` does. The reset-link
 * family is explicit: a reset/verify URL is a bearer credential for one
 * account, and logging one was the exact defect this detector was written for.
 */

/** A log call whose args are already redacted/masked is not a leak. */
const REDACTED_MARK = /redact|mask|\*{3,}|\[hidden\]|\[redacted\]/i;

/**
 * Reduce a log call's argument text to the parts that are CODE, not string
 * prose: drop '…' / "…" contents entirely, and for a template literal keep only
 * its ${…} interpolations. This is the precision guard — the name test then
 * sees `resetUrl` in ``console.log(`link ${resetUrl}`)`` but NOT the word
 * "token" in `console.log("token count", n)`.
 */
function logArgCode(args: string): string {
  const interps = (args.match(/\$\{[^}]*\}/g) ?? []).join(" ");
  const withoutStrings = args
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  return `${withoutStrings} ${interps}`;
}

/**
 * secretInLogs: a credential or single-use link passed to a logging call. Two
 * shapes, both precision-first:
 *   (a) a provider-signature secret sitting literally inside the log call —
 *       critical, and the value is redacted in the evidence.
 *   (b) a credential- or reset-link-named identifier logged as CODE (variable,
 *       object shorthand, or ${…} interpolation) — high.
 *
 * Logs are retained, shipped to aggregators, and broadly readable, so a secret
 * in a log is a leaked secret. This is the class that logging a raw password
 * reset link falls into (the value is a bearer credential for one account).
 */
export function secretInLogs(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const call = LOG_CALL.exec(line);
    if (!call) continue;

    // Arguments = from the log call's "(" to end of line. Line-based like the
    // rest of this module; a value and the call that logs it sit on one line.
    const argsStart = line.indexOf("(", call.index);
    const args = argsStart === -1 ? "" : line.slice(argsStart + 1);
    if (REDACTED_MARK.test(args)) continue;

    // (a) provider-signature secret logged verbatim.
    let providerHit: { provider: string; match: string } | null = null;
    for (const { provider, re } of SECRET_PROVIDERS) {
      const m = re.exec(args);
      if (m) {
        providerHit = { provider, match: m[0] };
        break;
      }
    }
    if (providerHit) {
      findings.push({
        route: file.path,
        severity: "critical",
        category: "security",
        title: `Secret written to a log (${providerHit.provider})`,
        detail:
          "A live credential is passed to a logging call. Logs are retained, " +
          "shipped to third-party aggregators, and widely readable, so a secret " +
          "in a log is a leaked secret. Remove it or log a redacted form.",
        evidence: { line: i + 1, snippet: redact(line, providerHit.match) },
      });
      continue; // one finding per log line is enough
    }

    // (b) a credential- or reset-link-named identifier logged as code.
    const nameHit = SECRET_NAME.exec(logArgCode(args));
    if (nameHit) {
      findings.push({
        route: file.path,
        severity: "high",
        category: "security",
        title: `Possible credential written to a log (${nameHit[0]})`,
        detail:
          "A value named like a credential or a single-use link is passed to a " +
          "logging call. A reset/verify link and a token are bearer credentials; " +
          "logging one leaks it. Log a non-sensitive identifier or a redacted form.",
        evidence: { line: i + 1, snippet: line.trim() },
      });
    }
  }

  return findings;
}

// eval(...) not preceded by `.` or a word char (so obj.eval(...) is excluded),
// and new Function(...) - both execute a string as live code.

/**
 * codeInjection: eval() or new Function() - running a string as code. It is
 * essentially never legitimate in application code, and if any part of the
 * argument is influenced by input it is remote code execution (CWE-95). Found by
 * the factory security dogfood: an `eval(userInput)` change was authored and
 * handed off because nothing flagged it.
 */
export function codeInjection(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isEval = EVAL_CALL.test(line);
    if (!isEval && !DYNAMIC_FUNCTION.test(line)) continue;
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    const which = isEval ? "eval()" : "new Function()";
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: `Code injection: ${which} runs a string as code`,
      detail:
        `${which} executes its argument as live code. If any part of it can be ` +
        "influenced by input, it is remote code execution (CWE-95). Use a parser " +
        "or an explicit allowlist instead of evaluating a string.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}


/**
 * sqlInjection: a SQL statement built by interpolating a value into the query
 * text (CWE-89). Parameterized queries ($1/$2 placeholders) are the safe form and
 * are never flagged. Found by the factory security dogfood: a
 * `SELECT ... WHERE id = '${id}'` change was authored and handed off un-flagged.
 */
export function sqlInjection(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A backticked template that carries BOTH a SQL keyword and a ${...} interp.
    const interpolated = /`/.test(line) && SQL_KEYWORD.test(line) && SQL_INTERP.test(line);
    if (!interpolated) continue;
    if (PARAMETERIZED.test(line)) continue; // uses placeholders -> safe
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "SQL injection: value interpolated into a query string",
      detail:
        "A SQL statement is built by putting a value directly into the query text, " +
        "so an attacker-controlled value can change the query (CWE-89). Use " +
        "parameterized queries ($1, $2 / placeholders), never string interpolation.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}

// A filesystem read/write sink. The path argument is the first arg.
const FS_SINK =
  /\bfs(?:\.promises)?\s*\.\s*(readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|readdir|readdirSync|unlink|unlinkSync|rm|rmSync)\s*\(/;
// A ${...} interpolation whose content is NOT a benign build-time constant.
const DYNAMIC_INTERP = /\$\{\s*(?!__dirname\b|__filename\b|process\.cwd\(\))[^}]+\}/;
// A string literal joined to an identifier, or `+ ident` - a dynamic path segment.
const PATH_CONCAT = /['"`][^'"`]*['"`]\s*\+|\+\s*[A-Za-z_$][\w$.]*/;
// path.basename() strips the directory portion, neutralizing traversal.
const BASENAME_GUARD = /\bbasename\s*\(/;

/**
 * pathTraversal: a filesystem read/write whose path is built by interpolating or
 * concatenating a value into it (CWE-22). `fs.readFileSync('./uploads/' + name)`
 * lets `name = '../../etc/passwd'` escape the intended directory. A call whose
 * path is a static literal, or where the name is reduced with path.basename(), is
 * never flagged. Found by the factory security dogfood: this exact shape was
 * authored and handed off un-flagged.
 */
export function pathTraversal(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = codeOnly(lines[i]);
    const m = FS_SINK.exec(line);
    if (!m) continue;
    const args = line.slice(line.indexOf("(", m.index) + 1);
    if (!DYNAMIC_INTERP.test(args) && !PATH_CONCAT.test(args)) continue; // static path -> safe
    if (BASENAME_GUARD.test(line)) continue; // name reduced to its base -> safe
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "Path traversal: user-influenced value built into a file path",
      detail:
        "A filesystem path is built by interpolating/concatenating a value, so a " +
        "value like '../../etc/passwd' escapes the intended directory (CWE-22). " +
        "Resolve against a fixed base and reject the result if it leaves that base, " +
        "or reduce the name with path.basename().",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}

// An outbound-request sink. The URL is the first argument.
const NET_SINK =
  /\b(?:fetch|axios|got|superagent)\s*(?:\.\s*(?:get|post|put|delete|patch|request|head))?\s*\(|\bhttps?\s*\.\s*(?:get|request)\s*\(/;
// Request-derived input: the URL came from the inbound request.
const REQ_SOURCE = /\b(?:req|request)\s*\.\s*(?:query|body|params|url)\b|searchParams\s*\.\s*get\s*\(|nextUrl\b/;
// A URL built by concatenating a scheme/empty literal to an identifier -> dynamic host.
const SCHEME_CONCAT = /^\s*(['"`])(?:https?:)?\/\/?\1\s*\+\s*[A-Za-z_$]|^\s*(['"`])\2\s*\+\s*[A-Za-z_$]/;
// A bare first-arg identifier whose NAME is a URL -> an externally-influenced host.
const URL_NAMED_IDENT =
  /^\s*(?:url|uri|endpoint|target|link|href|webhook|callback|dest|destination|redirect(?:Url)?)\s*[,)]/i;

/** The text of the first call argument (depth-aware up to the first top-level comma). */
function firstArg(afterParen: string): string {
  let depth = 0;
  for (let i = 0; i < afterParen.length; i++) {
    const c = afterParen[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return afterParen.slice(0, i);
      depth--;
    } else if (c === "," && depth === 0) return afterParen.slice(0, i);
  }
  return afterParen;
}

/** True when a call's argument list has a top-level comma (i.e. a 2nd argument). */
function hasSecondArg(afterParen: string): boolean {
  return firstArg(afterParen).length < afterParen.replace(/\)\s*$/, "").length && /,/.test(afterParen);
}

/**
 * The CODE portion of a line: empty for a comment-only line (// , *, /*), and
 * with any trailing `//` line comment removed (but NOT the `//` inside a URL like
 * https://). The code detectors below must not match patterns that appear only in
 * prose/JSDoc - "a hallucinated import (...)" in a comment is not an import() call.
 */
function codeOnly(line: string): string {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return line.replace(/(?<!:)\/\/.*$/, "");
}

/**
 * codeOnly, plus string-literal contents blanked out. For detectors that key on a
 * CALL (require()/import(), Math.random()), a pattern that appears only inside a
 * string - a `detail: "...uses Math.random()..."` or a `title: "...require()..."` -
 * is documentation, not a call, and must not match. Blanking string bodies leaves
 * `require("fs")` as `require("")` (still recognized as a safe literal specifier)
 * while a genuine `require(name)` is untouched.
 */
function codeNoStrings(line: string): string {
  return codeOnly(line)
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * ssrf: an outbound request whose URL/host is attacker-influenced (CWE-918) -
 * request-derived (req.query.url, searchParams.get), concatenated onto a bare
 * scheme ('http://' + host), or a first-arg identifier whose name IS a URL
 * (fetch(url)). A constant-host call (fetch('https://api.x/users'), or a template
 * with a fixed host and only a path interpolation) is NOT flagged - a dynamic host
 * is the SSRF shape, a dynamic path is not. Precise by design: a bare local
 * variable that is not url-named is left to the judge, not flagged here.
 */
export function ssrf(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = codeOnly(lines[i]);
    const m = NET_SINK.exec(line);
    if (!m) continue;
    const afterParen = line.slice(line.indexOf("(", m.index) + 1);
    const arg = firstArg(afterParen);
    // A bare url-named identifier is only SSRF-shaped when it is the SOLE argument
    // (`fetch(url)`); `fetch(url, { headers })` is the normal trusted-URL call and
    // must not be flagged (that heuristic produced 66 false positives on real code).
    const soleUrlArg = !hasSecondArg(afterParen) && URL_NAMED_IDENT.test(`${arg})`);
    const dynamicHost = REQ_SOURCE.test(arg) || SCHEME_CONCAT.test(arg) || soleUrlArg;
    if (!dynamicHost) continue;
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "SSRF: outbound request to an attacker-influenced host",
      detail:
        "The host of an outbound request is built from input, so an attacker can " +
        "point it at internal services or a cloud metadata endpoint (CWE-918). " +
        "Validate the URL against an allowlist of hosts before the request.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}

// require(...) / dynamic import(...). The module specifier is the first arg.
const MODULE_LOAD = /(?<![.\w$])require\s*\(|(?<![.\w$])import\s*\(/;
// A single static string-literal argument (the only safe form).
const STATIC_SPECIFIER = /^\s*(['"`])(?:(?!\1)[^\\])*\1\s*$/;

/**
 * dynamicModuleLoad: require()/import() with a non-literal specifier (CWE-98/829).
 * require(name) loads whatever module path the caller supplies - arbitrary code
 * execution if the value is influenced by input. A static specifier
 * (require('fs'), import('./Chart')) is the normal, safe form and is never
 * flagged. Found by the factory security dogfood: require(name) was handed off.
 */
export function dynamicModuleLoad(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = codeNoStrings(lines[i]);
    const m = MODULE_LOAD.exec(line);
    if (!m) continue;
    const afterParen = line.slice(line.indexOf("(", m.index) + 1);
    let arg = firstArg(afterParen);
    if (arg.trim() === "") {
      // Empty parens (`require()`) is never a module load - it is prose (e.g. a
      // wrapped block-comment line mentioning "require()"). Only look to the next
      // line when the call is genuinely open (the line ends with the "(").
      if (!/\(\s*$/.test(line)) continue;
      arg = firstArg(codeNoStrings(lines[i + 1] ?? "").trim());
    }
    if (arg.trim() === "" || STATIC_SPECIFIER.test(arg)) continue; // literal/absent module path -> safe
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "Dynamic module load: require()/import() of a non-literal path",
      detail:
        "A module is loaded from a computed specifier, so a value influenced by " +
        "input decides which code runs - arbitrary code execution (CWE-98/829). " +
        "Load from a fixed set of literal module paths, or map input through an " +
        "explicit allowlist.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}


/**
 * insecureRandomToken: Math.random() used to mint a credential (CWE-330).
 * Math.random is not cryptographically secure - its output is predictable, so a
 * token/password/OTP built from it can be guessed. Gated on a credential-named
 * context within the surrounding 3 lines (so Math.random for jitter/animation/ids
 * is not flagged). Use crypto.randomBytes / crypto.randomUUID instead.
 */
export function insecureRandomToken(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = codeNoStrings(lines[i]);
    if (!MATH_RANDOM.test(line)) continue;
    const ctx = `${codeNoStrings(lines[i - 2] ?? "")}\n${codeNoStrings(lines[i - 1] ?? "")}\n${line}`;
    if (!CRED_CONTEXT.test(ctx)) continue; // not a credential context -> benign randomness
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${line}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "Insecure randomness: Math.random() minting a credential",
      detail:
        "Math.random() is not cryptographically secure; its output is predictable, " +
        "so a token/password/OTP built from it can be guessed (CWE-330). Use " +
        "crypto.randomBytes() or crypto.randomUUID().",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }
  return findings;
}

const FOR_IN = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+in\s+[A-Za-z_$]/;
// A guard that makes a copy loop prototype-safe.
const PROTO_GUARD = /__proto__|hasOwnProperty|constructor|\bprototype\b|Object\.keys|Object\.entries|Object\.create\s*\(\s*null/;

/**
 * prototypePollution: a for..in copy loop that writes target[key] = source[key]
 * with no key guard (CWE-1321). An attacker-supplied key of "__proto__" walks up
 * to Object.prototype and pollutes every object. A loop that guards the key
 * (hasOwnProperty, an explicit __proto__/constructor check, or iterating
 * Object.keys) is not flagged. Found by the factory security dogfood: an
 * unguarded `merge(target, source)` was handed off.
 */
export function prototypePollution(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fm = FOR_IN.exec(codeOnly(lines[i]));
    if (!fm) continue;
    const key = fm[1];
    const body = lines.slice(i, Math.min(lines.length, i + 7)).map(codeOnly).join("\n");
    // A computed assignment keyed by the loop variable: target[key] = ...
    const assign = new RegExp(`[A-Za-z_$][\\w$]*\\s*\\[\\s*${key}\\s*\\]\\s*=(?!=)`);
    if (!assign.test(body)) continue;
    if (PROTO_GUARD.test(body)) continue; // guarded -> safe
    if (/(audit-safe|eslint-disable)/i.test(`${lines[i - 1] ?? ""}\n${lines[i]}`)) continue;
    findings.push({
      route: file.path,
      severity: "critical",
      category: "security",
      title: "Prototype pollution: unguarded for..in copy into a keyed target",
      detail:
        "A for..in loop copies source[key] into target[key] without rejecting " +
        "'__proto__'/'constructor', so an attacker-supplied key pollutes " +
        "Object.prototype and affects every object (CWE-1321). Guard the key " +
        "(skip __proto__/constructor/prototype) or copy via Object.keys + a plain " +
        "target created with Object.create(null).",
      evidence: { line: i + 1, snippet: lines[i].trim() },
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
    ...hardcodedSecret(file),
    ...secretInLogs(file),
    ...codeInjection(file),
    ...sqlInjection(file),
    ...pathTraversal(file),
    ...ssrf(file),
    ...dynamicModuleLoad(file),
    ...insecureRandomToken(file),
    ...prototypePollution(file),
  ];
}
