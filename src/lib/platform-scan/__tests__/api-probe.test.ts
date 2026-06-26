/**
 * Tests for the gray-box API contract probe.
 *
 * fetch is mocked to return a status keyed on (url, method, hasCookie) so each
 * check can be driven independently. Covers: unauthenticated 200 → security
 * critical; invalid-body 200 → bug/high; invalid-body 500 → bug/critical; a
 * fully-correct endpoint → no findings; a network throw → unreachable/high.
 */

import { probeApi } from "../api-probe";
import type { ApiEndpointSpec } from "../api-probe";

const BASE = "https://target.example.com";
const COOKIE = "session=abc";

function ok(status: number): Response {
  return { status } as Response;
}

/**
 * Build a fetch mock from a router. The router sees the request shape and
 * returns a status (resolved Response) or throws (network error).
 */
function mockFetch(
  router: (req: { path: string; method: string; hasCookie: boolean }) => number | "throw",
): typeof fetch {
  return jest.fn(async (url: unknown, init: unknown) => {
    const u = String(url);
    const path = u.replace(BASE, "");
    const opts = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    const method = opts.method ?? "GET";
    const hasCookie = Boolean(opts.headers?.["Cookie"]);
    const out = router({ path, method, hasCookie });
    if (out === "throw") throw new Error("network");
    return ok(out);
  }) as unknown as typeof fetch;
}

describe("auth-enforcement", () => {
  it("flags a requiresAuth endpoint that serves 2xx unauthenticated as security/critical", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/leads", method: "GET", journey: "Lead list", requiresAuth: true },
    ];
    // 200 whether or not a cookie is present → leaks data.
    const fetchImpl = mockFetch(() => 200);
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    const auth = findings.find((f) => f.evidence.check === "auth");
    expect(auth).toMatchObject({
      route: "/api/leads",
      severity: "critical",
      category: "security",
    });
    expect(auth?.evidence).toMatchObject({ status: 200, check: "auth", method: "GET" });
  });

  it("does not flag a requiresAuth endpoint that 401s unauthenticated", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/leads", method: "GET", journey: "Lead list", requiresAuth: true },
    ];
    const fetchImpl = mockFetch(({ hasCookie }) => (hasCookie ? 200 : 401));
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    expect(findings).toEqual([]);
  });
});

describe("input-validation", () => {
  it("flags an endpoint that accepts an invalid body with 2xx as bug/high", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/leads", method: "POST", journey: "Create lead", invalidBody: { junk: true } },
    ];
    // POST (invalid body) → 200; GET reachability → 200.
    const fetchImpl = mockFetch(() => 200);
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    const v = findings.find((f) => f.evidence.check === "validation");
    expect(v).toMatchObject({ route: "/api/leads", severity: "high", category: "bug" });
    expect(v?.evidence).toMatchObject({ status: 200, check: "validation", method: "POST" });
  });

  it("flags an endpoint that 500s on an invalid body as bug/critical", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/leads", method: "POST", journey: "Create lead", invalidBody: { junk: true } },
    ];
    const fetchImpl = mockFetch(({ method }) => (method === "POST" ? 500 : 200));
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    const v = findings.find((f) => f.evidence.check === "validation");
    expect(v).toMatchObject({ route: "/api/leads", severity: "critical", category: "bug" });
    expect(v?.evidence).toMatchObject({ status: 500, check: "validation", method: "POST" });
  });

  it("respects a custom expectRejectStatuses and produces no finding on a correct reject", async () => {
    const endpoints: ApiEndpointSpec[] = [
      {
        path: "/api/leads",
        method: "PATCH",
        journey: "Update lead",
        invalidBody: { junk: true },
        expectRejectStatuses: [409],
      },
    ];
    const fetchImpl = mockFetch(({ method }) => (method === "PATCH" ? 409 : 200));
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    expect(findings).toEqual([]);
  });
});

describe("reachability", () => {
  it("flags a GET 500 as bug/critical server error", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/health", method: "GET", journey: "Health" },
    ];
    const fetchImpl = mockFetch(() => 500);
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ route: "/api/health", severity: "critical", category: "bug" });
    expect(findings[0].evidence).toMatchObject({ check: "reachability", method: "GET" });
  });

  it("flags a network throw as bug/high unreachable", async () => {
    const endpoints: ApiEndpointSpec[] = [
      { path: "/api/health", method: "GET", journey: "Health" },
    ];
    const fetchImpl = mockFetch(() => "throw");
    const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ route: "/api/health", severity: "high", category: "bug" });
    expect(findings[0].evidence).toMatchObject({ check: "reachability", status: null });
  });
});

it("emits NO findings for a clean endpoint (401 unauth, 400 on invalid, 200 normal)", async () => {
  const endpoints: ApiEndpointSpec[] = [
    {
      path: "/api/leads",
      method: "POST",
      journey: "Create lead",
      requiresAuth: true,
      invalidBody: { junk: true },
    },
  ];
  const fetchImpl = mockFetch(({ method, hasCookie }) => {
    if (!hasCookie) return 401; // auth check, unauthenticated
    if (method === "POST") return 400; // invalid body correctly rejected
    return 200; // GET reachability
  });
  const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
  expect(findings).toEqual([]);
});

it("never throws; aggregates findings across multiple endpoints", async () => {
  const endpoints: ApiEndpointSpec[] = [
    { path: "/api/a", method: "GET", journey: "A", requiresAuth: true },
    { path: "/api/b", method: "POST", journey: "B", invalidBody: {} },
  ];
  const fetchImpl = mockFetch(({ path, method }) => {
    if (path === "/api/a") return 200; // serves data unauthenticated → security crit
    if (path === "/api/b" && method === "POST") return 500; // 500s on invalid → bug crit
    return 200;
  });
  const findings = await probeApi({ baseUrl: BASE, cookie: COOKIE, endpoints, fetchImpl });
  expect(findings.map((f) => `${f.route}:${f.evidence.check}:${f.severity}`)).toEqual(
    expect.arrayContaining([
      "/api/a:auth:critical",
      "/api/b:validation:critical",
    ]),
  );
});
