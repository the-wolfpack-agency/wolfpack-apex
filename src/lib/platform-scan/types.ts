/**
 * Platform-scan domain types.
 *
 * A platform scan is an agent crawling a TARGET external platform's routes and
 * classifying each into structured findings (bug / ux gap / broken journey /
 * security / performance). This is distinct from the agent SELF-scan
 * (src/lib/agents/scan.ts), which introspects this platform's own tool surface.
 *
 * The first scan modality is black-box route health: reachability, auth
 * enforcement, server errors, and latency over HTTP. The findings model is
 * deliberately modality-agnostic so a later browser-journey runner or a static
 * source analyzer can emit the SAME ScanFinding into the same store.
 */

export type ScanSeverity = "critical" | "high" | "medium" | "low";

export type ScanCategory =
  | "bug"
  | "ux_gap"
  | "broken_journey"
  | "security"
  | "performance";

/** One issue found on one route. evidence carries the raw signal (status code,
 *  redirect target, latency) so a reviewer can verify without re-running. */
export interface ScanFinding {
  route: string;
  severity: ScanSeverity;
  category: ScanCategory;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
}

/** A route to probe + its EXPECTED auth behavior, so the scanner can tell a real
 *  gap (admin page served 200 unauthenticated) from correct behavior (redirect
 *  to login). */
export interface ScanRouteSpec {
  path: string;
  journey: string;
  auth: "required" | "public";
}

export interface PlatformScanInput {
  workspaceId: string;
  platform: string;
  baseUrl: string;
  routes: ScanRouteSpec[];
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Latency above which a 2xx is flagged performance/low. Default 2500ms. */
  slowMs?: number;
  /** Per-request timeout. Default 10000ms. */
  timeoutMs?: number;
  /** Extra request headers (e.g. an established session Cookie) so the crawl runs
   *  AUTHENTICATED — surfacing behind-login pages instead of just login redirects. */
  headers?: Record<string, string>;
  /** True when the crawl carries an authenticated session. Flips the auth-required
   *  semantics: a 200 is then EXPECTED (page reachable), while a bounce to login /
   *  401 means the session was not honored (a bug), not correct enforcement. */
  authenticated?: boolean;
  /**
   * Politeness knobs for the shared per-host limiter (see
   * `src/lib/platform-scan/http/polite-fetch.ts`). All optional with safe
   * defaults; a scan is a guest on a client's prod system, so the defaults are
   * deliberately gentle (small concurrency, paced, capped backoff). Setting
   * `politeness: false` is NOT offered - politeness is non-negotiable; tune the
   * numbers instead.
   */
  politeness?: PolitenessOptions;
  /**
   * Who is running the scan, used to attribute the platform.scan_throttled
   * analytics event when a probe backs off. Optional: absent, the engine
   * attributes throttling to a "system" actor so the politeness data still
   * reaches the learning loop even for unattended (canary / sweep) scans.
   */
  actor?: { id: string; role: string };
}

/**
 * Tunables for the per-host politeness layer. Mirrors the configurable fields of
 * PoliteFetchOptions but without the injected I/O seams (those are for tests).
 */
export interface PolitenessOptions {
  /** Max simultaneous in-flight requests to ONE host. Default 4. */
  perHostConcurrency?: number;
  /** Minimum gap between the start of two requests to the same host (ms). Default 150. */
  minGapMs?: number;
  /** Max retries on a 429/503 before giving up politely. Default 3. */
  maxRetries?: number;
  /** Base for exponential backoff when no Retry-After is given (ms). Default 500. */
  baseBackoffMs?: number;
  /** Absolute ceiling for any single backoff wait (ms). Default 30000. */
  maxBackoffMs?: number;
  /** Injected clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Injected sleep for tests; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Best-effort hook fired when a probe backs off, so the engine can emit
   *  platform.scan_throttled. Receives the host, the wait it is about to take,
   *  the triggering status, and the 1-based attempt number. */
  onThrottle?: (info: { host: string; retryAfterMs: number; reason: string; attempt: number }) => void;
}

/**
 * How much of the target a scan actually reached. The danger this guards: a scan
 * whose session expired or whose routes half-errored returns "0 findings" that is
 * visually identical to a clean bill. Coverage makes the difference explicit so a
 * degraded scan is NEVER reported as clean.
 *
 *  - attempted        routes probed this run.
 *  - succeeded        routes that returned a usable HTTP response (status < 500).
 *  - errored          routes that did NOT (network error / timeout / 5xx before
 *                     we could classify auth) - the scan could not see these.
 *  - authRequired     the manifest contains at least one login-gated route, so an
 *                     authenticated session matters for honest coverage.
 *  - authEstablished  the authenticated session was actually honored. False when
 *                     auth was required but no session headers were supplied, OR
 *                     an authenticated crawl was bounced to login / 401 on a
 *                     protected route (the session was not established/honored).
 *  - coverageRatio    succeeded / attempted (0 when nothing was attempted).
 */
export interface ScanCoverage {
  attempted: number;
  succeeded: number;
  errored: number;
  authRequired: boolean;
  authEstablished: boolean;
  coverageRatio: number;
}

export interface PlatformScanResult {
  platform: string;
  baseUrl: string;
  routeCount: number;
  okCount: number;
  findings: ScanFinding[];
  /**
   * Identifiers (route paths / file paths) this scan actually COVERED, the same
   * identifier space as `ScanFinding.route`. recordScan() uses this to
   * auto-resolve open findings on a covered route the scan no longer detects
   * (the bug was fixed). Omit it (e.g. external ingest) to skip auto-resolve:
   * we must not resolve what we don't know was re-checked.
   */
  scannedRoutes?: string[];
  /**
   * Per-run coverage accounting (see ScanCoverage). Optional for back-compat with
   * external-ingest results that did not probe routes themselves; the engine
   * always populates it.
   */
  coverage?: ScanCoverage;
}

/** A single route's observed response, the pure input to classification. */
export interface RouteObservation {
  status?: number;
  location?: string | null;
  durationMs: number;
  networkError?: boolean;
  /** Response headers, lower-cased keys. Drives the security-header / cookie /
   *  CORS checks. Set-Cookie is the combined value. Absent on a network error. */
  headers?: Record<string, string>;
}
