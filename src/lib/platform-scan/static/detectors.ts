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
const GUARD = /(\.ok\b|\.status\b|res\.ok|response\.ok|if\s*\(\s*!)/;

/**
 * silentFetch: a fetch(...) whose response is consumed via .json()/.text()
 * within the next ~6 lines WITHOUT any ok/status guard in that window. This is
 * the silent-blank-page class (the April-16 incident): a non-2xx body is parsed
 * as if it were data, and the page renders empty.
 */
export function silentFetch(file: SourceFile): ScanFinding[] {
  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];
  const WINDOW = 6;

  for (let i = 0; i < lines.length; i++) {
    if (!FETCH_OPEN.test(lines[i])) continue;

    // Examine the fetch line plus the next WINDOW lines.
    const end = Math.min(lines.length, i + 1 + WINDOW);
    const window = lines.slice(i, end);
    const windowText = window.join("\n");

    const consumes = window.some((l) => CONSUME.test(l));
    if (!consumes) continue;

    // If anything in the window guards the response, it is not silent.
    if (GUARD.test(windowText)) continue;

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

const USE_CLIENT = /["']use client["']/;
// fetch("/api/...) or fetch(`/api/...`) but NOT fetchWithRefresh.
const RAW_API_FETCH = /(?<!WithRefresh)\bfetch\s*\(\s*[`"']\/api\//;

/**
 * rawAuthedFetchInClient: a "use client" file that calls raw fetch() against
 * /api directly (not via fetchWithRefresh). Client fetches must go through the
 * refresh wrapper; a raw call gets a 401 when the 15-min JWT expires and blanks
 * the page instead of rotating the token.
 */
export function rawAuthedFetchInClient(file: SourceFile): ScanFinding[] {
  if (!USE_CLIENT.test(file.content)) return [];

  const lines = file.content.split("\n");
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RAW_API_FETCH.test(line)) continue;
    // Defensive: skip fetchWithRefresh even if the lookbehind somehow misses.
    if (/fetchWithRefresh/.test(line)) continue;

    findings.push({
      route: file.path,
      severity: "medium",
      category: "security",
      title:
        "raw fetch to /api from a client component (no token refresh; 401 blanks the page)",
      detail:
        "This client component calls fetch() against /api directly instead of fetchWithRefresh. " +
        "On JWT expiry the 401 is not handled, so the page blanks instead of refreshing the token.",
      evidence: { line: i + 1, snippet: line.trim() },
    });
  }

  return findings;
}

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

/** Compose every detector over one file. */
export function runDetectors(file: SourceFile): ScanFinding[] {
  return [
    ...silentFetch(file),
    ...rawAuthedFetchInClient(file),
    ...hardcodedTenantId(file),
  ];
}
