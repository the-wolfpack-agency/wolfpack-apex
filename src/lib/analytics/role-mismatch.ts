/**
 * A control the user could see, could click, and was never allowed to use.
 *
 * The API returning 403 is the security layer working perfectly. It is also,
 * from the person's side of the screen, a button that does nothing. They click
 * it, the page does not change, and they conclude the product is broken. The
 * fix is never on the API side: the control has to leave that role's view.
 *
 * Nobody reports this. There is no error to screenshot and no message to
 * quote, so it does not reach us as a bug, it reaches us as somebody quietly
 * using the product less. A lighter version shipped on the Porsche build and
 * immediately caught a real user attempting three times to submit a user to an
 * organisation he was not part of. Three attempts, no complaint.
 *
 * ONE INSTRUMENTATION POINT, BY CONSTRUCTION. Every authenticated client fetch
 * in this product goes through fetchWithRefresh, and a guardrail test
 * (src/__tests__/no-raw-api-fetch.test.ts) fails the build if one does not. So
 * recording there catches every mismatched control that exists, including ones
 * added later by somebody who has never read this file. Per-control
 * instrumentation would only have covered whatever we remembered to annotate.
 *
 * REPEAT ATTEMPTS ARE THE SIGNAL, not the raw count. One 403 can be a race, a
 * stale page, or a permission changed a second ago. The same person clicking
 * the same dead control three times is the product lying to them, and that is
 * what the aggregation ranks by.
 */

/** Endpoints that must never be reported on, to avoid a feedback loop. */
const NEVER_REPORT = [
  /* Reporting a failed report would recurse until the tab died. */
  "/api/analytics",
  /* A 403 here is the auth system refusing, not a control being offered. */
  "/api/auth/",
];

/**
 * Should this refusal be recorded as a control-level mismatch?
 *
 * Read-only requests are excluded deliberately. A GET that 403s is usually a
 * page fetching something incidental for a role that cannot see it, which is
 * scoping working as intended rather than a control that lied. The defect this
 * exists to find is a control somebody ACTED on, and acting is a write.
 */
export function shouldReportMismatch(url: string, method: string): boolean {
  if (NEVER_REPORT.some((p) => url.includes(p))) return false;
  /* Same-origin API routes only. A third party's 403 is their problem. */
  if (!url.includes("/api/")) return false;
  return method.toUpperCase() !== "GET";
}

/**
 * The endpoint, with identifiers removed.
 *
 * "/api/clients/8f21.../documents" and the same path for another client are
 * one control, not two, so ids are collapsed. Without this the aggregation
 * ranks by how many different records somebody clicked rather than by how
 * often a control failed, and the repeat-attempt signal disappears entirely.
 */
export function controlKey(url: string): string {
  let path: string;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    path = url;
  }
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    /* Long opaque slugs are ids too, and 16-plus hex is the common shape. */
    .replace(/\/[0-9a-f]{16,}/gi, "/:id");
}
