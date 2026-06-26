/**
 * Demo-login canary: a continuous end-to-end proof that the platform-scan tool
 * still works against real demo targets.
 *
 * The risk this guards: every other test mocks the network. A green unit suite
 * can sit on top of a tool that no longer logs into anything, or a scanner that
 * has stopped emitting findings. The canary closes that gap by exercising the
 * REAL machinery (`establishSession` / `establishOAuthPasswordSession` →
 * `scanPlatform` / `probeApi`) against demo platforms that are KNOWN to be buggy,
 * and asserting the expected findings still surface. A regression — login broke,
 * the scan broke, or a known-buggy demo's findings dropped to zero — becomes an
 * unhealthy result that the cron alerts on, BEFORE a client hits it.
 *
 * This module reuses the existing scan/session machinery wholesale; it adds no
 * new probing logic. Like the rest of platform-scan, it NEVER throws: a target
 * error becomes an unhealthy result with a reason, so one bad demo can't abort
 * the sweep.
 *
 * It does NOT persist via recordScan — that store is workspace-scoped and the
 * canary is a workspace-agnostic health probe. The canary's signal is the
 * returned CanaryResult[] plus the analytics events + admin alert the cron emits.
 */

import {
  establishSession,
  establishOAuthPasswordSession,
} from "./session";
import { scanPlatform } from "./engine";
import { probeApi, type ApiEndpointSpec } from "./api-probe";
import type { ScanRouteSpec } from "./types";

/** Default routes a canary crawls when a target supplies none of its own. These
 *  mirror the manifest's DEFAULT_CONNECTION_ROUTES: a login page + the common
 *  behind-login surfaces, so an authenticated scan of a buggy demo finds bugs. */
const DEFAULT_CANARY_ROUTES: ScanRouteSpec[] = [
  { path: "/", journey: "Home", auth: "public" },
  { path: "/login", journey: "Login", auth: "public" },
  { path: "/dashboard", journey: "Dashboard", auth: "required" },
  { path: "/account", journey: "Account", auth: "required" },
  { path: "/settings", journey: "Settings", auth: "required" },
];

/** Default API endpoints probed in `mode: "api"` when a target supplies none. A
 *  safe authenticated REST-root probe proves login + execution end to end. */
const DEFAULT_CANARY_ENDPOINTS: ApiEndpointSpec[] = [
  { path: "/api/health", method: "GET", journey: "API health", requiresAuth: false },
];

/**
 * One demo target the canary logs into + scans. Read from the JSON env array, so
 * the shape is intentionally forgiving — unknown fields are ignored, optional
 * fields fall back to safe defaults.
 */
export interface CanaryTarget {
  name: string;
  baseUrl: string;
  loginPath: string;
  /** Cookie the session lives under (form login). Default "session". */
  sessionCookieName?: string;
  username: string;
  password: string;
  /** Login flow. Default "username_password". */
  authType?: "username_password" | "oauth_password";
  /** OAuth password flow only. */
  clientId?: string;
  clientSecret?: string;
  /** "http" → crawl routes with scanPlatform; "api" → probeApi. Default "http". */
  mode?: "http" | "api";
  /** A healthy scan of a known-buggy demo MUST find at least this many findings.
   *  Zero findings against a known-buggy demo = the scanner regressed. Default 1. */
  expectMinFindings?: number;
  /** Routes to crawl in http mode. Defaults to DEFAULT_CANARY_ROUTES. */
  routes?: ScanRouteSpec[];
  /** Endpoints to probe in api mode. Defaults to DEFAULT_CANARY_ENDPOINTS. */
  endpoints?: ApiEndpointSpec[];
}

/** The verdict for one canary target. */
export interface CanaryResult {
  name: string;
  loginOk: boolean;
  scanOk: boolean;
  findingCount: number;
  healthy: boolean;
  /** Why an unhealthy result is unhealthy (login failed / scan threw / findings
   *  dropped below the floor). Absent on a healthy result. */
  reason?: string;
}

/**
 * Injectable seams so the canary is fully unit-testable without a network. The
 * defaults bind to the REAL machinery, so production exercises the same code
 * paths the scan tool uses.
 */
export interface CanaryDeps {
  establishSession: typeof establishSession;
  establishOAuthPasswordSession: typeof establishOAuthPasswordSession;
  scanPlatform: typeof scanPlatform;
  probeApi: typeof probeApi;
}

const DEFAULT_DEPS: CanaryDeps = {
  establishSession,
  establishOAuthPasswordSession,
  scanPlatform,
  probeApi,
};

/**
 * Parse the DEMO_CANARY_TARGETS env value into a target list. Defensive: a bad
 * JSON string, a non-array, or entries missing the required fields all yield an
 * empty list (or skip the bad entry) rather than crash. The canary is INERT when
 * the env is unset — same posture as the platform-scan-browser spec.
 */
export function parseCanaryTargets(raw: string | undefined | null): CanaryTarget[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const targets: CanaryTarget[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : undefined;
    const baseUrl = typeof e.baseUrl === "string" ? e.baseUrl : undefined;
    const loginPath = typeof e.loginPath === "string" ? e.loginPath : undefined;
    const username = typeof e.username === "string" ? e.username : undefined;
    const password = typeof e.password === "string" ? e.password : undefined;
    // Required fields — skip a malformed entry rather than crash the whole list.
    if (!name || !baseUrl || !loginPath || !username || !password) continue;

    const authType =
      e.authType === "oauth_password" ? "oauth_password" : "username_password";
    const mode = e.mode === "api" ? "api" : "http";

    targets.push({
      name,
      baseUrl,
      loginPath,
      username,
      password,
      authType,
      mode,
      sessionCookieName:
        typeof e.sessionCookieName === "string" ? e.sessionCookieName : undefined,
      clientId: typeof e.clientId === "string" ? e.clientId : undefined,
      clientSecret: typeof e.clientSecret === "string" ? e.clientSecret : undefined,
      expectMinFindings:
        typeof e.expectMinFindings === "number" && e.expectMinFindings >= 0
          ? e.expectMinFindings
          : undefined,
    });
  }
  return targets;
}

/** Establish a session for a target, returning the auth headers + the base URL
 *  to scan against, or null on login failure. Never throws. */
async function login(
  target: CanaryTarget,
  deps: CanaryDeps,
): Promise<{ headers: Record<string, string>; baseUrl: string } | null> {
  if (target.authType === "oauth_password") {
    const session = await deps.establishOAuthPasswordSession({
      baseUrl: target.baseUrl,
      loginPath: target.loginPath,
      clientId: target.clientId ?? "",
      clientSecret: target.clientSecret ?? "",
      username: target.username,
      password: target.password,
    });
    if (!session) return null;
    // The token operates against the provider-returned instance URL.
    return { headers: { Authorization: session.authHeader }, baseUrl: session.instanceUrl };
  }

  const session = await deps.establishSession({
    baseUrl: target.baseUrl,
    loginPath: target.loginPath,
    sessionCookieName: target.sessionCookieName,
    username: target.username,
    password: target.password,
  });
  if (!session) return null;
  return { headers: { Cookie: session.cookie }, baseUrl: target.baseUrl };
}

/**
 * Run the canary against one target. Never throws — any failure becomes an
 * unhealthy result with a reason.
 */
async function runOne(target: CanaryTarget, deps: CanaryDeps): Promise<CanaryResult> {
  const minFindings = target.expectMinFindings ?? 1;
  try {
    // (a) Log in. A login failure is a regression: the tool can no longer reach
    //     the surface it is meant to scan.
    const session = await login(target, deps);
    if (!session) {
      return {
        name: target.name,
        loginOk: false,
        scanOk: false,
        findingCount: 0,
        healthy: false,
        reason: "login failed",
      };
    }

    // (b) Run the scan with the established session. http → scanPlatform across
    //     the routes; api → probeApi across the endpoints.
    let findingCount: number;
    if (target.mode === "api") {
      const findings = await deps.probeApi({
        baseUrl: session.baseUrl,
        authHeaders: session.headers,
        endpoints: target.endpoints ?? DEFAULT_CANARY_ENDPOINTS,
      });
      findingCount = findings.length;
    } else {
      const result = await deps.scanPlatform({
        workspaceId: "canary",
        platform: target.name,
        baseUrl: session.baseUrl,
        routes: target.routes ?? DEFAULT_CANARY_ROUTES,
        headers: session.headers,
        authenticated: true,
      });
      findingCount = result.findings.length;
    }

    // (c) A healthy scan of a KNOWN-BUGGY demo must still surface its bugs. Zero
    //     (or below-floor) findings means the scanner stopped detecting — a
    //     regression just as real as login breaking.
    const meetsFloor = findingCount >= minFindings;
    return {
      name: target.name,
      loginOk: true,
      scanOk: true,
      findingCount,
      healthy: meetsFloor,
      reason: meetsFloor
        ? undefined
        : `findings ${findingCount} below expected minimum ${minFindings}`,
    };
  } catch (err) {
    // A thrown session/scan dependency must not abort the sweep — it is itself an
    // unhealthy signal (the machinery errored where it used to work).
    return {
      name: target.name,
      loginOk: false,
      scanOk: false,
      findingCount: 0,
      healthy: false,
      reason: `error: ${(err as Error).message}`,
    };
  }
}

/**
 * Run the demo-login canary across every target. Targets run concurrently (the
 * list is curated + small). Never throws.
 */
export async function runDemoCanary(
  targets: CanaryTarget[],
  deps: Partial<CanaryDeps> = {},
): Promise<CanaryResult[]> {
  const resolved: CanaryDeps = { ...DEFAULT_DEPS, ...deps };
  return Promise.all(targets.map((t) => runOne(t, resolved)));
}
