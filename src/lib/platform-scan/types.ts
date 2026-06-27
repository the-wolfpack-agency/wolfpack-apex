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
