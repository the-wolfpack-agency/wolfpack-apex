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
export function classify(spec: ScanRouteSpec, obs: RouteObservation, slowMs: number, authenticated = false): ScanFinding[] {
  const base = { route: spec.path };
  const evidence = {
    status: obs.status ?? null,
    location: obs.location ?? null,
    durationMs: Math.round(obs.durationMs),
    expectedAuth: spec.auth,
    authenticated,
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
    if (spec.auth === "required") {
      // Authenticated crawl: a 401/403 means our session was NOT honored — a bug.
      return authenticated
        ? [F("high", "bug", `Authenticated request rejected (${s})`, `${spec.journey}: returned ${s} despite a valid session — the session was not honored or the route is broken.`)]
        : []; // unauthenticated: correct, auth enforced
    }
    return [F("high", "bug", `Public route requires auth (${s})`, `${spec.journey}: a route expected to be public returned ${s}, so customers cannot reach it.`)];
  }
  if (isRedirect(s)) {
    if (spec.auth === "required") {
      if (looksLikeLogin(obs.location)) {
        // Authenticated crawl bounced to login = session not honored (bug);
        // unauthenticated bounce to login = correct enforcement.
        return authenticated
          ? [F("high", "bug", "Authenticated request bounced to login", `${spec.journey}: redirected to the login page despite a valid session — the session was not honored.`)]
          : [];
      }
      return [F("low", "ux_gap", "Unexpected redirect on protected route", `${spec.journey}: redirected to ${obs.location ?? "an unknown location"} instead of the login page.`)];
    }
    return [F("low", "ux_gap", "Public route redirects", `${spec.journey}: a public route redirected to ${obs.location ?? "an unknown location"}; confirm this is the intended canonical destination.`)];
  }
  // 2xx (and any other 2xx-ish success).
  if (s >= 200 && s < 300) {
    const findings: ScanFinding[] = [];
    // A 200 on an auth-required route is an access-control gap ONLY when we did
    // not send a session. Authenticated, a 200 is the expected healthy result.
    if (spec.auth === "required" && !authenticated) {
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
  headers?: Record<string, string>,
): Promise<RouteObservation> {
  const url = `${baseUrl.replace(/\/$/, "")}${spec.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers });
    const hdrs: Record<string, string> = {};
    // Real fetch Headers always expose forEach; guard so an exotic/mocked headers
    // object without it degrades to "no headers" rather than failing the probe.
    if (typeof res.headers?.forEach === "function") {
      res.headers.forEach((value, key) => {
        hdrs[key.toLowerCase()] = value;
      });
    }
    return {
      status: res.status,
      location: res.headers.get("location"),
      durationMs: performance.now() - startedAt,
      headers: hdrs,
    };
  } catch {
    return { networkError: true, durationMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function hdr(obs: RouteObservation, name: string): string | undefined {
  return obs.headers?.[name.toLowerCase()];
}

/**
 * Global response-header hardening, checked ONCE on a representative successful
 * response. These headers are set by middleware / the CDN identically on every
 * route, so a per-route check would just emit N duplicates of the same gap.
 * Each missing header maps to a concrete attack: no CSP (XSS), no nosniff (MIME
 * confusion), no frame protection (clickjacking), no HSTS (TLS downgrade).
 */
export function missingHeaderFindings(routePath: string, obs: RouteObservation, isHttps: boolean): ScanFinding[] {
  const out: ScanFinding[] = [];
  const F = (severity: ScanFinding["severity"], title: string, detail: string): ScanFinding => ({
    route: routePath, severity, category: "security", title, detail, evidence: { status: obs.status ?? 0 },
  });
  const csp = hdr(obs, "content-security-policy");
  if (!csp) {
    out.push(F("medium", "Missing Content-Security-Policy", "No CSP header. A CSP is the primary defense-in-depth against XSS and injection; without it an injected script runs unrestricted."));
  }
  if ((hdr(obs, "x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    out.push(F("low", "Missing X-Content-Type-Options: nosniff", "Responses can be MIME-sniffed by the browser, enabling content-type confusion. Set X-Content-Type-Options: nosniff."));
  }
  const cspFrames = csp ? /frame-ancestors/i.test(csp) : false;
  if (!hdr(obs, "x-frame-options") && !cspFrames) {
    out.push(F("medium", "Missing clickjacking protection", "Neither X-Frame-Options nor CSP frame-ancestors is set, so this page can be framed by any site (clickjacking). Set frame-ancestors 'none'/'self' or X-Frame-Options: DENY."));
  }
  if (isHttps && !hdr(obs, "strict-transport-security")) {
    out.push(F("medium", "Missing Strict-Transport-Security (HSTS)", "No HSTS on an HTTPS response. A network attacker can downgrade the first request to HTTP. Set Strict-Transport-Security with a long max-age."));
  }
  return out;
}

/**
 * Per-response cookie + CORS hardening. These DO vary by route (a login route
 * sets the session cookie; an API route sets CORS), so they are checked on every
 * response and de-duplicated by route+title upstream.
 */
export function cookieAndCorsFindings(routePath: string, obs: RouteObservation, isHttps: boolean): ScanFinding[] {
  const out: ScanFinding[] = [];
  const F = (severity: ScanFinding["severity"], title: string, detail: string): ScanFinding => ({
    route: routePath, severity, category: "security", title, detail, evidence: { status: obs.status ?? 0 },
  });
  const setCookie = hdr(obs, "set-cookie");
  if (setCookie) {
    const missing: string[] = [];
    if (!/;\s*httponly/i.test(setCookie)) missing.push("HttpOnly");
    if (isHttps && !/;\s*secure/i.test(setCookie)) missing.push("Secure");
    if (!/;\s*samesite/i.test(setCookie)) missing.push("SameSite");
    if (missing.length > 0) {
      const sev = missing.includes("HttpOnly") || missing.includes("Secure") ? "high" : "medium";
      out.push(F(sev, `Insecure Set-Cookie (missing ${missing.join(", ")})`, `A cookie is set without ${missing.join(", ")}. Missing HttpOnly exposes it to XSS theft, missing Secure allows interception over HTTP, missing SameSite enables CSRF. Set all three on session cookies.`));
    }
  }
  const acao = hdr(obs, "access-control-allow-origin");
  if (acao === "*") {
    const creds = (hdr(obs, "access-control-allow-credentials") ?? "").toLowerCase() === "true";
    if (creds) {
      out.push(F("critical", "CORS wildcard with credentials", "Access-Control-Allow-Origin: * together with Allow-Credentials: true lets ANY website read authenticated responses. Echo a specific allowed origin instead of '*' for credentialed endpoints."));
    } else {
      out.push(F("medium", "CORS allows any origin (ACAO: *)", "Access-Control-Allow-Origin: * exposes this response to any site. Restrict to an explicit allowlist if it returns non-public data."));
    }
  }
  return out;
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
      const obs = await probe(input.baseUrl, spec, fetchImpl, timeoutMs, input.headers);
      return { spec, obs, findings: classify(spec, obs, slowMs, input.authenticated) };
    }),
  );

  const findings = perRoute.flatMap((r) => r.findings);
  const isHttps = input.baseUrl.startsWith("https:");

  // Global headers: once, on a representative successful response (avoids N dupes).
  const rep = perRoute.find((r) => r.obs.headers && (r.obs.status ?? 0) >= 200 && (r.obs.status ?? 0) < 400);
  if (rep) findings.push(...missingHeaderFindings(rep.spec.path, rep.obs, isHttps));

  // Cookie + CORS: per response, de-duplicated by route+title.
  const seen = new Set<string>();
  for (const r of perRoute) {
    if (!r.obs.headers) continue;
    for (const f of cookieAndCorsFindings(r.spec.path, r.obs, isHttps)) {
      const key = `${f.route}|${f.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  const routesWithFindings = perRoute.filter((r) => r.findings.length > 0).length;
  return {
    platform: input.platform,
    baseUrl: input.baseUrl,
    routeCount: input.routes.length,
    okCount: input.routes.length - routesWithFindings,
    findings,
    // Every probed route is "covered", letting recordScan auto-resolve findings on
    // these routes that are no longer detected (matches ScanFinding.route = spec.path).
    scannedRoutes: input.routes.map((s) => s.path),
  };
}
