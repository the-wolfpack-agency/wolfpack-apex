/**
 * Browser-journey classifier for the platform-scan feature.
 *
 * This is the BROWSER analog of the black-box route probe (src/lib/platform-scan).
 * A Playwright runner loads each target page authenticated, observes the live
 * browser signals (console errors, CSP violations, failed in-page API calls,
 * server status, and whether anything rendered), and hands the raw observation
 * here. classifyPage is a PURE function: same observation in, same findings out,
 * so every rule is unit-testable without a browser.
 *
 * The findings model is shared (ScanFinding) with the HTTP probe and the source
 * analyzer, so a browser finding lands in the SAME store and the SAME review UI.
 *
 * Headline rule: a page that makes a failed API call (>=400) while rendering is
 * the authenticated analog of the silent blank-page fetch bug — a 401/403 on a
 * background request leaves a page that "loaded" but is hollow. We surface it as
 * a high-severity bug rather than letting it hide behind a 200 document.
 */

import type { ScanFinding } from "../types";

/** The raw, browser-observed signals for one page load. Pure input to
 *  classifyPage — no Playwright types leak in, so it is trivially testable. */
export interface PageObservation {
  route: string;
  journey: string;
  /** Top-level document response status, when known. */
  status?: number;
  consoleErrors: string[];
  cspViolations: string[];
  failedRequests: { url: string; status: number }[];
  /** True when document.body had visible text after load. */
  renderedContent: boolean;
  durationMs: number;
}

/**
 * Classify one page observation into zero or more findings. A healthy page
 * (200, no console/CSP/failed/blank signals) yields []. A single page can yield
 * multiple findings (e.g. console errors AND a failed request AND a blank body).
 */
export function classifyPage(obs: PageObservation): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const { route, journey } = obs;

  // Server / routing status on the top-level document.
  if (obs.status !== undefined && obs.status >= 500) {
    findings.push({
      route,
      severity: "critical",
      category: "bug",
      title: `Server error (${obs.status})`,
      detail: `The page returned a ${obs.status} server error on the "${journey}" journey.`,
      evidence: { journey, status: obs.status, durationMs: obs.durationMs },
    });
  } else if (obs.status === 404) {
    findings.push({
      route,
      severity: "high",
      category: "broken_journey",
      title: "Route 404s",
      detail: `The page for the "${journey}" journey returned 404 (Not Found).`,
      evidence: { journey, status: 404 },
    });
  }

  // CSP violations: a hard signal that the page is shipping resources the
  // policy blocks — often the cause of a blank or half-rendered page.
  if (obs.cspViolations.length > 0) {
    findings.push({
      route,
      severity: "high",
      category: "security",
      title: "CSP violation on page",
      detail: `The page triggered ${obs.cspViolations.length} Content-Security-Policy violation(s) on the "${journey}" journey.`,
      evidence: {
        journey,
        count: obs.cspViolations.length,
        sample: obs.cspViolations[0] ?? null,
      },
    });
  }

  // Failed in-page API calls: the authenticated analog of the silent
  // blank-page fetch bug. A 401/403/5xx on a background request leaves a
  // page that "loaded" but is functionally hollow.
  const firstFailed = obs.failedRequests.find((r) => r.status >= 400);
  if (firstFailed) {
    findings.push({
      route,
      severity: "high",
      category: "bug",
      title: "Page made a failed API call (silent blank-page risk)",
      detail: `A background request returned ${firstFailed.status} on the "${journey}" journey; the page can render but be functionally empty.`,
      evidence: {
        journey,
        url: firstFailed.url,
        status: firstFailed.status,
        count: obs.failedRequests.filter((r) => r.status >= 400).length,
      },
    });
  }

  // Console errors: weaker signal, but a non-empty console error stream on an
  // authenticated page is a regression smell worth triaging.
  if (obs.consoleErrors.length > 0) {
    findings.push({
      route,
      severity: "medium",
      category: "bug",
      title: "Console errors on page",
      detail: `The page logged ${obs.consoleErrors.length} console error(s) on the "${journey}" journey.`,
      evidence: {
        journey,
        count: obs.consoleErrors.length,
        sample: obs.consoleErrors[0] ?? null,
      },
    });
  }

  // Blank render: the page loaded (status < 400) but painted no content. This
  // is the classic 401-blank-dashboard symptom from the UI side.
  if (!obs.renderedContent && (obs.status === undefined || obs.status < 400)) {
    findings.push({
      route,
      severity: "high",
      category: "ux_gap",
      title: "Page rendered blank / no content",
      detail: `The page loaded but rendered no visible content on the "${journey}" journey.`,
      evidence: {
        journey,
        status: obs.status ?? null,
        durationMs: obs.durationMs,
      },
    });
  }

  return findings;
}
