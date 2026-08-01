/**
 * Perform one acceptance run against a DEPLOYED site.
 *
 * Composition, not new machinery. The layout comparison is the spec-diff engine
 * that already exists (src/lib/spec-diff), driven by the platform-scan browser
 * with its read-only network floor, so a comparison can never issue a mutating
 * request at either target. The reachability probe is a plain fetch. Nothing new
 * is introduced to run this; what is new is that the two are pointed at the URL
 * a deploy just produced and their results are judged against a stored contract.
 *
 * Everything external is injected: the fetch, the browser factory and the
 * comparison itself. That is what lets the whole path be tested without a
 * network or a browser, including the failure paths that matter most (browser
 * will not start, prototype unreachable, a route that times out).
 *
 * Verifying on the DEPLOYED url rather than a local build is deliberate. A build
 * that passes locally and blanks in production is a failed build, and the only
 * way to know which one you have is to look at the one the client would open.
 */
import { evaluateAcceptance, type AcceptanceObservations, type AcceptanceVerdict, type RouteObservation } from "./evaluate";
import type { AcceptanceCriteria } from "./criteria";

/** Body bytes read per route. Enough to assert on real content, small enough
 *  that a misconfigured target cannot pull a large file into memory. */
const MAX_BODY_BYTES = 512 * 1024;
const ROUTE_TIMEOUT_MS = 15_000;

export interface LayoutComparison {
  summary?: {
    totalDiffs: number;
    totalMissing: number;
    fontMismatch: boolean;
    matchedElements: number;
    clean: boolean;
    worstOffenders: { text: string; field: string; delta: number }[];
  };
  /** Persisted spec-diff run, when the comparison produced one. */
  specDiffRunId?: string | null;
  error?: string;
}

export interface AcceptanceRunDeps {
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /**
   * Runs the layout comparison and returns its summary. Injected because the
   * real one starts a browser; a test supplies the numbers directly. Must
   * RESOLVE with `{ error }` rather than reject, so one failed comparison
   * cannot lose the route results that were already gathered.
   */
  compareLayout?: (input: { prototypeUrl: string; deployedUrl: string; criteria: AcceptanceCriteria }) => Promise<LayoutComparison>;
  /**
   * Refuses a URL that could reach the private network. Both URLs are
   * operator-supplied (the prototype at intake, the deploy from a webhook), so
   * both go through the same guard the scanner uses. Throwing is the point.
   */
  assertPublicUrl?: (url: string) => Promise<void>;
}

export interface AcceptanceRunResult {
  verdict: AcceptanceVerdict;
  observations: AcceptanceObservations;
  specDiffRunId: string | null;
  durationMs: number;
}

/** Join a deployed origin with a criteria path without producing a double slash
 *  or letting a path escape the origin. */
export function routeUrl(deployedUrl: string, path: string): string {
  const base = new URL(deployedUrl);
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  // A path is a path. If resolution moved us to another host, that is a bug or
  // an attempt, and either way the check must not follow it.
  if (url.origin !== base.origin) throw new Error(`route ${path} resolved off-origin`);
  return url.toString();
}

/** Probe one route. Never throws: an unreachable route is an observation, and
 *  the evaluator is what decides that it is a failure. */
async function probeRoute(url: string, path: string, fetchImpl: typeof fetch): Promise<RouteObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    // `redirect: "manual"` so a 302 to a login is seen as the 302 it is. Followed
    // silently it would arrive as a 200 for a page the client cannot use.
    const res = await fetchImpl(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "Instinct-Acceptance/1.0" } });
    let body: string | undefined;
    try {
      const text = await res.text();
      body = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
    } catch {
      // Status is still a real observation even when the body could not be read.
      body = undefined;
    }
    return { path, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : "request failed";
    return { path, status: null, error: message === "The operation was aborted." ? `timed out after ${ROUTE_TIMEOUT_MS}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check one deployed site against its criteria and return the verdict.
 *
 * Route probes run concurrently: they are independent reads, and a build with a
 * dozen required routes should not take a dozen sequential timeouts to judge.
 */
export async function runAcceptance(
  input: { deployedUrl: string; criteria: AcceptanceCriteria },
  deps: AcceptanceRunDeps = {},
): Promise<AcceptanceRunResult> {
  const startedAt = Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { criteria } = input;

  // The deployed URL comes from a webhook, so it is operator-influenced input.
  // If it cannot be cleared, nothing is probed and every check reports as
  // unmeasured, which the evaluator turns into "not accepted".
  let deployedUrl = input.deployedUrl;
  let blocked: string | null = null;
  try {
    deployedUrl = new URL(input.deployedUrl).toString();
    if (deps.assertPublicUrl) await deps.assertPublicUrl(deployedUrl);
  } catch (err) {
    blocked = err instanceof Error ? err.message : "invalid deployed url";
  }

  const routes: RouteObservation[] = blocked
    ? []
    : await Promise.all(
        criteria.requiredRoutes.map(async (path) => {
          let url: string;
          try {
            url = routeUrl(deployedUrl, path);
          } catch (err) {
            return { path, status: null, error: err instanceof Error ? err.message : "bad route" };
          }
          return probeRoute(url, path, fetchImpl);
        }),
      );

  let layout: LayoutComparison = {};
  if (blocked) {
    layout = { error: blocked };
  } else if (criteria.prototypeUrl && deps.compareLayout) {
    try {
      if (deps.assertPublicUrl) await deps.assertPublicUrl(criteria.prototypeUrl);
      layout = await deps.compareLayout({ prototypeUrl: criteria.prototypeUrl, deployedUrl, criteria });
    } catch (err) {
      layout = { error: err instanceof Error ? err.message : "comparison failed" };
    }
  } else if (criteria.prototypeUrl) {
    // A prototype was specified and no comparator was supplied. Reporting this
    // as unmeasured is the honest answer; silently skipping it would turn a
    // missing capability into a passing build.
    layout = { error: "no layout comparator available in this environment" };
  }

  const observations: AcceptanceObservations = { deployedUrl, routes, layout };
  return {
    verdict: evaluateAcceptance(criteria, observations),
    observations,
    specDiffRunId: layout.specDiffRunId ?? null,
    durationMs: Date.now() - startedAt,
  };
}

/** Map a verdict onto the stored status vocabulary. Kept next to the runner so
 *  the three writers cannot disagree about what "degraded" means. */
export function statusFromVerdict(verdict: AcceptanceVerdict): "passed" | "failed" | "degraded" {
  if (verdict.accepted) return "passed";
  return verdict.checks.some((c) => c.status === "failed") ? "failed" : "degraded";
}
