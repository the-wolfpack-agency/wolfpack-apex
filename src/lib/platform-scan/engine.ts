/**
 * Platform-scan engine: crawl a target's routes, classify each response into
 * structured findings. Pure + injectable fetch so the classification battery is
 * fully unit-testable without a network.
 *
 * Modality: black-box HTTP. We probe each route WITHOUT following redirects (so a
 * 3xx to /login is observable as "auth enforced") and WITHOUT credentials. That
 * surfaces, against an auth-gated platform:
 *   - protected route served 200 unauthenticated  -> security/critical
 *   - route 404s (dead link still in the journey)  -> broken_journey/high
 *   - route 5xx                                    -> bug/critical
 *   - route unreachable / timeout                  -> bug/high
 *   - public route redirects or 401s               -> ux_gap/bug
 *   - slow 2xx                                     -> performance/low
 * It cannot see client-rendered defects (a fetch without res.ok blanking a page);
 * that is the browser-journey / static-analysis layer, which emits the SAME
 * ScanFinding shape into the same store. This is the honest first layer.
 */

import type {
  PlatformScanInput,
  PlatformScanResult,
  RouteObservation,
  ScanFinding,
  ScanRouteSpec,
} from "./types";

const DEFAULT_SLOW_MS = 2500;
const DEFAULT_TIMEOUT_MS = 10000;

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;
const looksLikeLogin = (loc: string | null | undefined) =>
  !!loc && /(login|signin|sign-in|auth)/i.test(loc);

/**
 * Classify one route's observation into zero or more findings. Pure: this is the
 * heart of the scan and every branch is unit-tested directly.
 */
export function classify(spec: ScanRouteSpec, obs: RouteObservation, slowMs: number): ScanFinding[] {
  const base = { route: spec.path };
  const evidence = {
    status: obs.status ?? null,
    location: obs.location ?? null,
    durationMs: Math.round(obs.durationMs),
    expectedAuth: spec.auth,
  } as Record<string, string | number | boolean | null>;
  const F = (severity: ScanFinding["severity"], category: ScanFinding["category"], title: string, detail: string): ScanFinding =>
    ({ ...base, severity, category, title, detail, evidence });

  if (obs.networkError || obs.status === undefined) {
    return [F("high", "bug", "Route unreachable", `${spec.journey}: the route did not respond (network error or timeout).`)];
  }
  const s = obs.status;

  if (s >= 500) {
    return [F("critical", "bug", `Server error (${s})`, `${spec.journey}: the route returned a ${s}. A server error blanks the journey for every user.`)];
  }
  if (s === 404) {
    return [F("high", "broken_journey", "Route 404s", `${spec.journey}: a route in the navigation manifest returns 404 — a dead link / missing page in the journey.`)];
  }
  if (s === 429) {
    return [F("medium", "performance", "Rate limited (429)", `${spec.journey}: the route is rate limiting unauthenticated probes; verify thresholds are not too aggressive for real users.`)];
  }
  if (s === 401 || s === 403) {
    if (spec.auth === "required") return []; // correct: auth enforced
    return [F("high", "bug", `Public route requires auth (${s})`, `${spec.journey}: a route expected to be public returned ${s}, so customers cannot reach it.`)];
  }
  if (isRedirect(s)) {
    if (spec.auth === "required") {
      return looksLikeLogin(obs.location)
        ? [] // correct: protected route bounces to login
        : [F("low", "ux_gap", "Unexpected redirect on protected route", `${spec.journey}: redirected to ${obs.location ?? "an unknown location"} instead of the login page.`)];
    }
    return [F("low", "ux_gap", "Public route redirects", `${spec.journey}: a public route redirected to ${obs.location ?? "an unknown location"}; confirm this is the intended canonical destination.`)];
  }
  // 2xx (and any other 2xx-ish success).
  if (s >= 200 && s < 300) {
    const findings: ScanFinding[] = [];
    if (spec.auth === "required") {
      findings.push(F("critical", "security", "Protected route served content without auth", `${spec.journey}: returned ${s} to an UNauthenticated request. This route must redirect to login or 401 — serving it is an access-control gap.`));
    }
    if (obs.durationMs > slowMs) {
      findings.push(F("low", "performance", `Slow response (${Math.round(obs.durationMs)}ms)`, `${spec.journey}: responded in ${Math.round(obs.durationMs)}ms (> ${slowMs}ms). Slow journeys read as broken to users.`));
    }
    return findings;
  }
  // Unexpected 4xx.
  return [F("medium", "bug", `Unexpected status (${s})`, `${spec.journey}: returned an unexpected ${s}.`)];
}

/** Probe one route once. Never throws — a failure becomes a networkError observation. */
async function probe(
  baseUrl: string,
  spec: ScanRouteSpec,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RouteObservation> {
  const url = `${baseUrl.replace(/\/$/, "")}${spec.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal });
    return {
      status: res.status,
      location: res.headers.get("location"),
      durationMs: performance.now() - startedAt,
    };
  } catch {
    return { networkError: true, durationMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan a platform: probe every route in the manifest and collect findings.
 * Routes are probed concurrently (bounded by the manifest size — manifests are
 * curated, not unbounded crawls).
 */
export async function scanPlatform(input: PlatformScanInput): Promise<PlatformScanResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const slowMs = input.slowMs ?? DEFAULT_SLOW_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const perRoute = await Promise.all(
    input.routes.map(async (spec) => {
      const obs = await probe(input.baseUrl, spec, fetchImpl, timeoutMs);
      return classify(spec, obs, slowMs);
    }),
  );

  const findings = perRoute.flat();
  const routesWithFindings = perRoute.filter((f) => f.length > 0).length;
  return {
    platform: input.platform,
    baseUrl: input.baseUrl,
    routeCount: input.routes.length,
    okCount: input.routes.length - routesWithFindings,
    findings,
  };
}
