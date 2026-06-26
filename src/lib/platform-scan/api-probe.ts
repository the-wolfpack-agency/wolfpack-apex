/**
 * Gray-box API contract probe for platform-scan.
 *
 * Where the black-box engine (`engine.ts`) crawls RENDERED routes for health,
 * this probe exercises a target's API endpoints to surface CONTRACT and
 * VALIDATION bugs that only show up under adversarial input:
 *
 *   - auth-enforcement: a `requiresAuth` endpoint that serves 2xx WITHOUT a
 *     session cookie is leaking data (security/critical).
 *   - input-validation: a write endpoint that accepts a deliberately invalid
 *     body with 2xx has no validation (bug/high); one that 500s on it has
 *     unhandled input (bug/critical). A proper 400/422 reject is correct.
 *   - reachability: a GET that 500s is a server error (bug/critical); a network
 *     error means the endpoint is unreachable (bug/high).
 *
 * Each check emits 0-1 ScanFinding whose evidence carries the observed status,
 * the check kind, and the method, so a reviewer can verify without re-running.
 * The probe NEVER throws: a per-endpoint failure becomes its own finding (or is
 * skipped), so one bad endpoint can't abort the scan.
 */

import type { ScanFinding } from "./types";

/** Per-request timeout for a probe call. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** Default statuses that count as a CORRECT rejection of invalid input. */
const DEFAULT_REJECT_STATUSES = [400, 422];

export interface ApiEndpointSpec {
  path: string;
  method: "GET" | "POST" | "PATCH";
  /** Human-readable journey this endpoint belongs to. */
  journey: string;
  /** When true, the endpoint is probed unauthenticated to confirm it's gated. */
  requiresAuth?: boolean;
  /** A deliberately-invalid body to test input validation (POST/PATCH only). */
  invalidBody?: unknown;
  /** Statuses that count as a correct reject. Default [400, 422]. */
  expectRejectStatuses?: number[];
}

export interface ProbeApiInput {
  baseUrl: string;
  /** Auth headers for authenticated checks — `{ Cookie: "session=…" }` (form
   *  login) or `{ Authorization: "Bearer …" }` (oauth). Omitted = unauthenticated. */
  authHeaders?: Record<string, string>;
  endpoints: ApiEndpointSpec[];
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 8000ms. */
  timeoutMs?: number;
}

/** Outcome of a single probe request: a status, or a network error. */
interface ProbeResult {
  status?: number;
  networkError: boolean;
}

interface CallOptions {
  fetchImpl: typeof fetch;
  url: string;
  method: ApiEndpointSpec["method"];
  authHeaders?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** Fire one request, returning a status or a network-error flag. Never throws. */
async function call(opts: CallOptions): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = { ...(opts.authHeaders ?? {}) };
    const init: RequestInit = {
      method: opts.method,
      headers,
      signal: controller.signal,
      redirect: "manual",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await opts.fetchImpl(opts.url, init);
    return { status: res.status, networkError: false };
  } catch {
    return { networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

function is2xx(s: number | undefined): boolean {
  return s !== undefined && s >= 200 && s < 300;
}
function is5xx(s: number | undefined): boolean {
  return s !== undefined && s >= 500 && s < 600;
}

/**
 * Probe a target's API endpoints for contract/validation/auth bugs. Returns the
 * flat list of findings across all endpoints and checks.
 */
export async function probeApi(input: ProbeApiInput): Promise<ScanFinding[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const findings: ScanFinding[] = [];

  for (const ep of input.endpoints) {
    const url = `${input.baseUrl}${ep.path}`;
    const rejectStatuses = ep.expectRejectStatuses ?? DEFAULT_REJECT_STATUSES;

    // --- auth-enforcement: hit the endpoint WITHOUT the cookie. ---
    if (ep.requiresAuth) {
      const r = await call({ fetchImpl, url, method: ep.method, timeoutMs });
      if (!r.networkError && is2xx(r.status)) {
        findings.push({
          route: ep.path,
          severity: "critical",
          category: "security",
          title: "Endpoint serves data without auth",
          detail: `${ep.method} ${ep.path} returned ${r.status} with no auth headers; it should require authentication.`,
          evidence: { status: r.status ?? null, check: "auth", method: ep.method, journey: ep.journey },
        });
      }
      // 401/403 = correct; 404/5xx = a different signal, skip here.
    }

    // --- input-validation: hit WITH the cookie + an invalid body. ---
    if (ep.invalidBody !== undefined && (ep.method === "POST" || ep.method === "PATCH")) {
      const r = await call({
        fetchImpl,
        url,
        method: ep.method,
        authHeaders: input.authHeaders,
        body: ep.invalidBody,
        timeoutMs,
      });
      if (!r.networkError) {
        if (is5xx(r.status)) {
          findings.push({
            route: ep.path,
            severity: "critical",
            category: "bug",
            title: "Endpoint 500s on invalid input (unhandled)",
            detail: `${ep.method} ${ep.path} returned ${r.status} on a deliberately invalid body; validation errors should be handled, not crash the server. Expected one of ${rejectStatuses.join("/")}.`,
            evidence: { status: r.status ?? null, check: "validation", method: ep.method, journey: ep.journey },
          });
        } else if (is2xx(r.status)) {
          findings.push({
            route: ep.path,
            severity: "high",
            category: "bug",
            title: "Endpoint accepts invalid input (no validation)",
            detail: `${ep.method} ${ep.path} returned ${r.status} on a deliberately invalid body; it should reject with one of ${rejectStatuses.join("/")}.`,
            evidence: { status: r.status ?? null, check: "validation", method: ep.method, journey: ep.journey },
          });
        }
        // A status in rejectStatuses (or any 4xx) = correct rejection, no finding.
      }
      // networkError here is surfaced by the reachability check below.
    }

    // --- reachability: a GET (with cookie) sanity check. ---
    {
      const r = await call({ fetchImpl, url, method: "GET", authHeaders: input.authHeaders, timeoutMs });
      if (r.networkError) {
        findings.push({
          route: ep.path,
          severity: "high",
          category: "bug",
          title: "Endpoint unreachable",
          detail: `GET ${ep.path} produced a network error; the endpoint could not be reached.`,
          evidence: { status: null, check: "reachability", method: "GET", journey: ep.journey },
        });
      } else if (is5xx(r.status)) {
        findings.push({
          route: ep.path,
          severity: "critical",
          category: "bug",
          title: "Endpoint server error",
          detail: `GET ${ep.path} returned ${r.status}; the endpoint is erroring.`,
          evidence: { status: r.status ?? null, check: "reachability", method: "GET", journey: ep.journey },
        });
      }
    }
  }

  return findings;
}
