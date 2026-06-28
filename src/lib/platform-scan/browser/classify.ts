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

/**
 * One observed UI element, distilled from a Playwright role-snapshot plus
 * computed styles. The openclaw runner populates these; the classifier stays
 * pure (no Playwright types leak in). Every field is the SIGNAL a snapshot can
 * cheaply provide, deliberately small so a detector can reason about it without
 * a live page. Fields are optional so a runner that cannot determine a signal
 * leaves it undefined, and detectors that need it simply skip the element
 * (precision-first: never guess on missing data).
 */
export interface UiElement {
  /** The lowercase HTML tag name, e.g. "button", "a", "div". */
  tag: string;
  /** The computed/explicit ARIA role, e.g. "button", "link", "dialog". */
  role?: string;
  /** The accessible name (aria-label, aria-labelledby text, or label assoc). */
  accessibleName?: string;
  /** True when the element is operable (clickable/focusable control). */
  interactive?: boolean;
  /** True when the control is disabled (disabled attr or aria-disabled). */
  disabled?: boolean;
  /** True when an explanation is present (title or aria-describedby resolves). */
  hasExplanation?: boolean;
  /** The rendered bounding box in CSS pixels. Absent when not measurable. */
  box?: { w: number; h: number };
  /** True when the element is a descendant of a dialog/alertdialog. */
  inDialog?: boolean;
  /** True when the element itself is the dialog/modal container. */
  isDialog?: boolean;
  /** The visible text content of the element, trimmed. */
  textContent?: string;
}

/**
 * One axe-core accessibility violation, distilled to the few fields the
 * classifier needs. The browser runner captures the RAW axe result via
 * window.axe.run() and maps each violation to this shape (one entry per RULE,
 * not per node; nodeCount conveys breadth). The classifier stays pure: no
 * axe-core import, no browser - it consumes these plain records server-side.
 *
 * We reuse axe-core (the WCAG gold-standard engine) rather than rebuilding
 * thousands of a11y rules ourselves. axe runs in the page; only this distilled
 * record crosses back to the pure layer, so the classifier never depends on axe.
 */
export interface AxeViolation {
  /** The axe rule id, e.g. "color-contrast", "button-name", "label". */
  id: string;
  /** axe's impact rating; drives our severity mapping. */
  impact: "critical" | "serious" | "moderate" | "minor";
  /** Human-readable summary of the rule, e.g. "Buttons must have discernible text". */
  help: string;
  /** Deep link to the axe rule docs, when axe supplies one. */
  helpUrl?: string;
  /** How many DOM nodes violated this rule on the page (breadth signal). */
  nodeCount: number;
}

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
  /**
   * Optional per-element snapshot for the granular usability/UX detectors.
   * Additive: when absent, classifyPage behaves exactly as before. When present,
   * the UX detectors run over it. The runner populates this from a role-snapshot
   * plus computed styles; the classifier never touches a browser.
   */
  elements?: UiElement[];
  /**
   * Optional RAW axe-core violations for this page. Additive: when absent or
   * empty, classifyPage behaves exactly as before. When present, classifyAxe
   * turns them into ScanFindings. The runner captures these via window.axe.run();
   * the classifier never imports axe.
   */
  axeViolations?: AxeViolation[];
}

/** Treat an element as interactive when explicitly flagged OR when its role is
 *  one of the unambiguous interactive roles. Conservative on purpose: we never
 *  infer interactivity from tag alone. */
function isInteractive(el: UiElement): boolean {
  if (el.interactive === true) return true;
  return (
    el.role === "button" ||
    el.role === "link" ||
    el.role === "menuitem" ||
    el.role === "tab"
  );
}

/**
 * a. An interactive control with NO accessible name AND no text content is an
 * unlabeled control (the classic icon-only button) - invisible to a screen
 * reader and ambiguous to sighted users. Fires ux_gap/medium. Precision guard:
 * only fires when the element is clearly interactive; an element with EITHER an
 * accessible name OR text content is fine and is skipped.
 */
export function iconOnlyControlNoName(
  el: UiElement,
  route: string,
  journey: string,
): ScanFinding | null {
  if (!isInteractive(el)) return null;
  const hasName = !!el.accessibleName && el.accessibleName.trim().length > 0;
  const hasText = !!el.textContent && el.textContent.trim().length > 0;
  if (hasName || hasText) return null;
  return {
    route,
    severity: "medium",
    category: "ux_gap",
    title: "Interactive control has no accessible name",
    detail: `An interactive ${el.role ?? el.tag} on the "${journey}" journey has no accessible name and no text, so it is unclear to screen readers and ambiguous as an icon-only control.`,
    evidence: { journey, tag: el.tag, role: el.role ?? null },
  };
}

/**
 * b. A disabled interactive control with no explanation leaves the user stuck:
 * the control is dead and nothing tells them why or how to enable it. Fires
 * ux_gap/low. Precision guard: requires disabled === true AND interactive AND
 * hasExplanation !== true; a disabled control WITH a title/aria-describedby is
 * fine and is skipped.
 */
export function disabledControlNoExplanation(
  el: UiElement,
  route: string,
  journey: string,
): ScanFinding | null {
  if (el.disabled !== true) return null;
  if (!isInteractive(el)) return null;
  if (el.hasExplanation === true) return null;
  return {
    route,
    severity: "low",
    category: "ux_gap",
    title: "Disabled control with no explanation",
    detail: `A disabled ${el.role ?? el.tag} on the "${journey}" journey gives no explanation (no title / aria-describedby), so the user cannot tell why it is unavailable.`,
    evidence: { journey, tag: el.tag, role: el.role ?? null },
  };
}

/**
 * c. A tap target smaller than 44px on either axis is below the WCAG 2.5.5 /
 * Apple HIG minimum touch-target size (44x44 CSS px), so it is hard to hit on
 * touch devices. Fires ux_gap/low. Precision guard: requires a real measured
 * box (w>0 AND h>0) so an unmeasured (0x0 / undefined) element never fires a
 * false positive; only an interactive element with a genuinely tiny box flags.
 */
export function tinyTapTarget(
  el: UiElement,
  route: string,
  journey: string,
): ScanFinding | null {
  if (!isInteractive(el)) return null;
  if (!el.box) return null;
  const { w, h } = el.box;
  if (!(w > 0 && h > 0)) return null;
  // 44 CSS px is the WCAG 2.5.5 (AAA) / Apple HIG / Material minimum.
  const MIN = 44;
  if (w >= MIN && h >= MIN) return null;
  return {
    route,
    severity: "low",
    category: "ux_gap",
    title: "Tap target smaller than 44px",
    detail: `An interactive ${el.role ?? el.tag} on the "${journey}" journey is ${w}x${h}px, below the 44x44px minimum touch-target size.`,
    evidence: { journey, tag: el.tag, role: el.role ?? null, w, h },
  };
}

/**
 * d. A dialog/modal must announce itself: it needs role="dialog"/"alertdialog"
 * AND an accessible name, or assistive tech presents an anonymous, unannounced
 * overlay. Fires ux_gap/medium when the element is the dialog but is missing the
 * right role OR a name. Precision guard: only fires when isDialog === true. NOTE:
 * focus-trap and Escape-to-close checks are v2 - they require interaction, which
 * a static snapshot cannot observe.
 */
export function dialogNoAccessibleName(
  el: UiElement,
  route: string,
  journey: string,
): ScanFinding | null {
  if (el.isDialog !== true) return null;
  const roleOk = el.role === "dialog" || el.role === "alertdialog";
  const hasName = !!el.accessibleName && el.accessibleName.trim().length > 0;
  if (roleOk && hasName) return null;
  return {
    route,
    severity: "medium",
    category: "ux_gap",
    title: "Modal/dialog missing role or accessible name",
    detail: `A modal/dialog on the "${journey}" journey ${roleOk ? "has no accessible name" : `uses role "${el.role ?? "(none)"}" instead of dialog/alertdialog`}, so assistive tech cannot announce it.`,
    evidence: { journey, tag: el.tag, role: el.role ?? null },
  };
}

/**
 * Map an axe impact rating to our ScanSeverity. axe has four impact levels; we
 * collapse them onto our four-level scale: critical -> high (the worst we model
 * for an a11y issue; a hard server error stays the only "critical"), serious ->
 * medium, moderate/minor -> low. An unrecognized impact returns null so the
 * caller skips it (precision-first: never guess a severity for an unknown rating).
 */
function axeImpactToSeverity(
  impact: AxeViolation["impact"],
): ScanFinding["severity"] | null {
  switch (impact) {
    case "critical":
      return "high";
    case "serious":
      return "medium";
    case "moderate":
      return "low";
    case "minor":
      return "low";
    default:
      return null;
  }
}

/**
 * Classify RAW axe-core violations into ScanFindings.
 *
 * WHY category "ux_gap" and not a new "accessibility" category: an accessibility
 * defect IS a usability gap - a control no screen reader can announce, a contrast
 * ratio no low-vision user can read. It belongs in the same review bucket as the
 * hand-written UX detectors above, flows through the same recordScan -> learning
 * pipeline, and needs no new ScanCategory (which would ripple through types.ts,
 * the store, and the gate - all of which we deliberately do NOT touch). The
 * "Accessibility:" title prefix distinguishes a11y findings in the report.
 *
 * Dedupe by axe rule id: axe reports one violation object per rule with N nodes;
 * we emit exactly ONE finding per rule and carry nodeCount as the breadth signal,
 * so a rule failing on 40 nodes is one reviewable finding, not 40. If the same id
 * appears twice (defensive - axe shouldn't), the first wins.
 *
 * Pure: same violations in, same findings out. No browser, no axe import.
 */
export function classifyAxe(
  violations: AxeViolation[],
  route: string,
  journey: string,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    if (seen.has(v.id)) continue;
    const severity = axeImpactToSeverity(v.impact);
    // Unknown/missing impact: skip (precision-first).
    if (severity === null) continue;
    seen.add(v.id);
    const helpUrlSuffix = v.helpUrl ? ` See ${v.helpUrl}` : "";
    findings.push({
      route,
      severity,
      category: "ux_gap",
      title: `Accessibility: ${v.help}`,
      detail: `axe-core rule "${v.id}" (impact: ${v.impact}) failed on ${v.nodeCount} element(s) on the "${journey}" journey.${helpUrlSuffix}`,
      evidence: {
        axe_id: v.id,
        impact: v.impact,
        nodes: v.nodeCount,
        journey,
        helpUrl: v.helpUrl ?? null,
      },
    });
  }
  return findings;
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

  // Granular usability / UX detectors. Additive: only run when the runner
  // supplied a per-element snapshot. When obs.elements is absent, behavior is
  // identical to before. Each detector is precision-first and skips elements
  // missing the data it needs, so no false positives from undefined.
  if (obs.elements) {
    for (const el of obs.elements) {
      for (const detector of [
        iconOnlyControlNoName,
        disabledControlNoExplanation,
        tinyTapTarget,
        dialogNoAccessibleName,
      ]) {
        const f = detector(el, route, journey);
        if (f) findings.push(f);
      }
    }
  }

  // Deterministic accessibility findings from axe-core. Additive: only runs when
  // the runner supplied a non-empty axeViolations array. When absent or empty,
  // output is byte-identical to before (back-compat). The a11y findings flow
  // through the same recordScan -> learning pipeline as every other finding.
  if (obs.axeViolations && obs.axeViolations.length > 0) {
    findings.push(...classifyAxe(obs.axeViolations, route, journey));
  }

  return findings;
}
