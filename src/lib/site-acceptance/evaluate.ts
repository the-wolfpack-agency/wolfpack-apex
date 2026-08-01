/**
 * Turn observations of a deployed site into a verdict against its criteria.
 *
 * Pure by design: no browser, no database, no clock. The runner does the
 * measuring and hands the numbers here, which means every rule below is unit
 * tested directly, including the ones that only fire when something is broken.
 * Those are the rules that matter, and they are the ones an end-to-end test can
 * almost never reach on purpose.
 *
 * THE ONE RULE THAT IS NOT NEGOTIABLE
 *
 * A check that could not run is a FAILURE, not a pass. If the browser would not
 * start, if the prototype was unreachable, if a route timed out, the verdict is
 * "not accepted" and the reason says so. The alternative is the specific lie
 * this whole layer exists to prevent: a green tick that means "we did not look."
 * That is why `degraded` never softens the verdict; it only explains it.
 */
import type { AcceptanceCriteria } from "./criteria";

export type CheckId = "routes" | "content" | "layout" | "font";
export type CheckStatus = "passed" | "failed" | "skipped" | "unmeasured";

export interface AcceptanceCheck {
  id: CheckId;
  status: CheckStatus;
  /** One line an operator can act on, not a stack trace. */
  detail: string;
  /** Everything the UI needs to show the failure without another query. */
  evidence?: Record<string, unknown>;
}

export interface RouteObservation {
  path: string;
  /** null when the request never completed (DNS, TLS, timeout, connection reset). */
  status: number | null;
  /** Body text, when it was read. Absent means "not measured", not "empty page". */
  body?: string;
  error?: string;
}

export interface LayoutObservation {
  /** Absent when there is no prototype to compare against. */
  summary?: {
    totalDiffs: number;
    totalMissing: number;
    fontMismatch: boolean;
    matchedElements: number;
    clean: boolean;
    worstOffenders: { text: string; field: string; delta: number }[];
  };
  /** Why the comparison could not run. Presence means "unmeasured". */
  error?: string;
}

export interface AcceptanceObservations {
  deployedUrl: string;
  routes: RouteObservation[];
  layout: LayoutObservation;
}

export interface AcceptanceVerdict {
  /** True only when every enforced check passed. Never true on an unmeasured one. */
  accepted: boolean;
  checks: AcceptanceCheck[];
  /** True when at least one check could not be measured. Explains, never excuses. */
  degraded: boolean;
  /** One sentence for a notification or a list row. */
  summary: string;
}

/** 2xx is the bar. A 3xx to a login and a 404 both render nothing useful. */
const isOk = (status: number | null): boolean => status != null && status >= 200 && status < 300;

function evaluateRoutes(criteria: AcceptanceCriteria, routes: RouteObservation[]): AcceptanceCheck {
  const expected = criteria.requiredRoutes;
  const seen = new Map(routes.map((r) => [r.path, r]));
  const missing = expected.filter((p) => !seen.has(p));
  if (missing.length > 0) {
    return {
      id: "routes",
      status: "unmeasured",
      detail: `${missing.length} required route(s) were never checked: ${missing.join(", ")}`,
      evidence: { missing },
    };
  }
  const failures = expected
    .map((p) => seen.get(p) as RouteObservation)
    .filter((r) => !isOk(r.status))
    .map((r) => ({ path: r.path, status: r.status, error: r.error }));

  if (failures.length > 0) {
    return {
      id: "routes",
      status: "failed",
      detail: failures
        .map((f) => `${f.path} answered ${f.status ?? f.error ?? "nothing"}`)
        .join("; "),
      evidence: { failures },
    };
  }
  return { id: "routes", status: "passed", detail: `${expected.length} route(s) answered 2xx`, evidence: { checked: expected } };
}

function evaluateContent(criteria: AcceptanceCriteria, routes: RouteObservation[]): AcceptanceCheck {
  if (criteria.requiredContent.length === 0) {
    return { id: "content", status: "skipped", detail: "no required content specified" };
  }
  // Content is asserted against every body we actually read. A body we never
  // read cannot prove absence, so if nothing was read this is unmeasured.
  const bodies = routes.filter((r) => typeof r.body === "string").map((r) => (r.body as string).toLowerCase());
  if (bodies.length === 0) {
    return { id: "content", status: "unmeasured", detail: "no page body was read, so required content could not be checked" };
  }
  const missing = criteria.requiredContent.filter((needle) => !bodies.some((b) => b.includes(needle.toLowerCase())));
  if (missing.length > 0) {
    return {
      id: "content",
      status: "failed",
      detail: `not found on any checked page: ${missing.join(", ")}`,
      evidence: { missing, pagesChecked: bodies.length },
    };
  }
  return { id: "content", status: "passed", detail: `${criteria.requiredContent.length} required phrase(s) present` };
}

function evaluateLayout(criteria: AcceptanceCriteria, layout: LayoutObservation): AcceptanceCheck {
  if (criteria.prototypeUrl == null) {
    return { id: "layout", status: "skipped", detail: "no prototype URL on this project, so there is nothing to compare against" };
  }
  if (!layout.summary) {
    return {
      id: "layout",
      status: "unmeasured",
      detail: layout.error ? `the comparison could not run: ${layout.error}` : "the comparison did not produce a result",
    };
  }
  const { totalDiffs, totalMissing, matchedElements, worstOffenders } = layout.summary;
  // Nothing matched means the two pages had no comparable elements at all, which
  // is a broken comparison wearing the costume of a perfect one: zero diffs.
  if (matchedElements === 0) {
    return {
      id: "layout",
      status: "unmeasured",
      detail: "no elements matched between the prototype and the build, so a zero difference count proves nothing",
      evidence: { totalMissing },
    };
  }
  if (totalDiffs > criteria.maxLayoutDiffs) {
    return {
      id: "layout",
      status: "failed",
      detail: `${totalDiffs} element(s) outside the ${criteria.tolerancePx}px tolerance (limit ${criteria.maxLayoutDiffs})`,
      evidence: { totalDiffs, totalMissing, matchedElements, worstOffenders },
    };
  }
  return {
    id: "layout",
    status: "passed",
    detail: `${matchedElements} element(s) matched within ${criteria.tolerancePx}px`,
    evidence: { totalDiffs, totalMissing, matchedElements },
  };
}

function evaluateFont(criteria: AcceptanceCriteria, layout: LayoutObservation): AcceptanceCheck {
  if (!criteria.requireFontParity) return { id: "font", status: "skipped", detail: "font parity not required" };
  if (criteria.prototypeUrl == null) return { id: "font", status: "skipped", detail: "no prototype URL to take the typeface from" };
  if (!layout.summary) {
    return { id: "font", status: "unmeasured", detail: layout.error ? `the comparison could not run: ${layout.error}` : "no font sample was taken" };
  }
  return layout.summary.fontMismatch
    ? { id: "font", status: "failed", detail: "the build serves a different typeface than the prototype" }
    : { id: "font", status: "passed", detail: "typeface matches the prototype" };
}

/**
 * Evaluate every criterion. The order is the order an operator reads them in:
 * is it up, does it say the right thing, does it look right, is it set in the
 * right type.
 */
export function evaluateAcceptance(criteria: AcceptanceCriteria, obs: AcceptanceObservations): AcceptanceVerdict {
  const checks: AcceptanceCheck[] = [
    evaluateRoutes(criteria, obs.routes),
    evaluateContent(criteria, obs.routes),
    evaluateLayout(criteria, obs.layout),
    evaluateFont(criteria, obs.layout),
  ];

  const failed = checks.filter((c) => c.status === "failed");
  const unmeasured = checks.filter((c) => c.status === "unmeasured");
  const accepted = failed.length === 0 && unmeasured.length === 0;

  let summary: string;
  if (accepted) {
    const ran = checks.filter((c) => c.status === "passed").length;
    summary = `Accepted: ${ran} check(s) passed against ${obs.deployedUrl}`;
  } else if (failed.length > 0) {
    summary = `Not accepted: ${failed.map((c) => c.id).join(", ")} failed`;
    if (unmeasured.length > 0) summary += `; ${unmeasured.map((c) => c.id).join(", ")} could not be checked`;
  } else {
    summary = `Not accepted: ${unmeasured.map((c) => c.id).join(", ")} could not be checked, so this is not a pass`;
  }

  return { accepted, checks, degraded: unmeasured.length > 0, summary };
}
