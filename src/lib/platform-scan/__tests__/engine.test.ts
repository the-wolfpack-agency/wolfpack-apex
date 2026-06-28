/**
 * The scan engine's classification battery (the heart of the feature) + the
 * crawl aggregation. classify() is pure, so every branch is asserted directly;
 * scanPlatform() is exercised with an injected fetch (no network).
 */
import { classify, scanPlatform, missingHeaderFindings, cookieAndCorsFindings, computeCoverage } from "@/lib/platform-scan/engine";
import type { ScanRouteSpec, RouteObservation } from "@/lib/platform-scan/types";

const REQ: ScanRouteSpec = { path: "/admin/leads", journey: "Lead inbox", auth: "required" };
const PUB: ScanRouteSpec = { path: "/inventory", journey: "Public inventory", auth: "public" };
const SLOW = 2500;

describe("classify", () => {
  it("flags a server error as a critical bug", () => {
    const f = classify(REQ, { status: 500, durationMs: 10 }, SLOW);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", category: "bug" });
  });

  it("flags a 404 on a manifest route as a high broken_journey", () => {
    expect(classify(REQ, { status: 404, durationMs: 10 }, SLOW)[0]).toMatchObject({
      severity: "high", category: "broken_journey",
    });
  });

  it("flags a protected route that serves 200 unauthenticated as a CRITICAL security gap", () => {
    expect(classify(REQ, { status: 200, durationMs: 10 }, SLOW)[0]).toMatchObject({
      severity: "critical", category: "security",
    });
  });

  it("treats a protected route redirecting to login as correct (no finding)", () => {
    expect(classify(REQ, { status: 302, location: "/admin/login?callbackUrl=/admin/leads", durationMs: 10 }, SLOW)).toEqual([]);
  });

  it("treats a 401/403 on a protected route as correct (auth enforced)", () => {
    expect(classify(REQ, { status: 401, durationMs: 10 }, SLOW)).toEqual([]);
    expect(classify(REQ, { status: 403, durationMs: 10 }, SLOW)).toEqual([]);
  });

  it("flags a protected route redirecting somewhere OTHER than login as a ux_gap", () => {
    expect(classify(REQ, { status: 302, location: "/somewhere-else", durationMs: 10 }, SLOW)[0]).toMatchObject({
      severity: "low", category: "ux_gap",
    });
  });

  it("flags a public route that 401s as a high bug (customers cannot reach it)", () => {
    expect(classify(PUB, { status: 401, durationMs: 10 }, SLOW)[0]).toMatchObject({
      severity: "high", category: "bug",
    });
  });

  it("treats a public 200 as healthy, but flags it when slow", () => {
    expect(classify(PUB, { status: 200, durationMs: 10 }, SLOW)).toEqual([]);
    const slow = classify(PUB, { status: 200, durationMs: 4000 }, SLOW);
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ severity: "low", category: "performance" });
  });

  it("emits BOTH a security and a performance finding for a slow, unauthenticated-200 protected route", () => {
    const f = classify(REQ, { status: 200, durationMs: 4000 }, SLOW);
    expect(f.map((x) => x.category).sort()).toEqual(["performance", "security"]);
  });

  it("flags an unreachable route (network error / timeout) as a high bug", () => {
    expect(classify(REQ, { networkError: true, durationMs: 10000 }, SLOW)[0]).toMatchObject({
      severity: "high", category: "bug", title: "Route unreachable",
    });
  });

  it("flags a 429 as a medium performance issue", () => {
    expect(classify(PUB, { status: 429, durationMs: 10 }, SLOW)[0]).toMatchObject({
      severity: "medium", category: "performance",
    });
  });

  it("AUTHENTICATED crawl: a 200 on a protected route is healthy (NOT a security finding)", () => {
    // The false-positive guard: with a session, behind-login 200s are expected.
    expect(classify(REQ, { status: 200, durationMs: 10 }, SLOW, true)).toEqual([]);
  });

  it("AUTHENTICATED crawl: a bounce to login means the session was not honored (bug)", () => {
    expect(classify(REQ, { status: 302, location: "/login", durationMs: 10 }, SLOW, true)[0]).toMatchObject({
      severity: "high", category: "bug", title: "Authenticated request bounced to login",
    });
  });

  it("AUTHENTICATED crawl: a 401 on a protected route means the session was rejected (bug)", () => {
    expect(classify(REQ, { status: 401, durationMs: 10 }, SLOW, true)[0]).toMatchObject({
      severity: "high", category: "bug",
    });
  });

  it("carries the raw signal as evidence for reviewer verification", () => {
    const f = classify(REQ, { status: 500, location: null, durationMs: 123.7 }, SLOW)[0];
    expect(f.evidence).toMatchObject({ status: 500, durationMs: 124, expectedAuth: "required" });
  });
});

describe("scanPlatform", () => {
  // Default to a fully-hardened header set so the header checks stay silent and
  // these tests stay focused on classify(); the security-header tests below pass
  // an insecure header set explicitly.
  const SECURE_HEADERS: Record<string, string> = {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=63072000",
  };
  function mkRes(status: number, location?: string, headers: Record<string, string> = SECURE_HEADERS) {
    const h = new Headers(headers);
    if (location) h.set("location", location);
    return { status, headers: h } as unknown as Response;
  }

  it("crawls every route, aggregates findings, and counts healthy routes", async () => {
    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/inventory")) return mkRes(200); // public, healthy
      if (u.endsWith("/admin")) return mkRes(302, "/admin/login"); // protected, enforced -> healthy
      if (u.endsWith("/admin/leads")) return mkRes(500); // bug
      throw new Error("network"); // /admin/gone -> unreachable
    }) as unknown as typeof fetch;

    const res = await scanPlatform({
      workspaceId: "ws-1",
      platform: "wolfpack-auto",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: [
        { path: "/inventory", journey: "Public inventory", auth: "public" },
        { path: "/admin", journey: "Dashboard", auth: "required" },
        { path: "/admin/leads", journey: "Leads", auth: "required" },
        { path: "/admin/gone", journey: "Removed", auth: "required" },
      ],
    });

    expect(res.routeCount).toBe(4);
    expect(res.okCount).toBe(2); // /inventory + /admin enforced
    expect(res.findings).toHaveLength(2); // 500 + unreachable
    expect(res.findings.map((f) => f.category).sort()).toEqual(["bug", "bug"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // baseUrl + path, redirects NOT followed (so 3xx is observable).
    expect(String((fetchImpl as jest.Mock).mock.calls[0][0])).toBe("https://demo.example.com/inventory");
    expect((fetchImpl as jest.Mock).mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("flags missing security headers once, and insecure cookies/CORS per response", async () => {
    const fetchImpl = jest.fn(async () =>
      mkRes(200, undefined, {
        // no CSP, no nosniff, no frame protection, no HSTS
        "set-cookie": "session=abc; Path=/",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      }),
    ) as unknown as typeof fetch;

    const res = await scanPlatform({
      workspaceId: "ws-1",
      platform: "t",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: [
        { path: "/", journey: "Home", auth: "public" },
        { path: "/app", journey: "App", auth: "public" },
      ],
    });

    const titles = res.findings.map((f) => f.title);
    // Global header findings appear ONCE despite two routes.
    expect(titles.filter((t) => t === "Missing Content-Security-Policy")).toHaveLength(1);
    expect(titles.filter((t) => t === "Missing Strict-Transport-Security (HSTS)")).toHaveLength(1);
    expect(titles).toContain("Missing clickjacking protection");
    // Cookie + CORS are critical/high security findings.
    expect(res.findings.some((f) => f.severity === "critical" && f.title === "CORS wildcard with credentials")).toBe(true);
    expect(res.findings.some((f) => f.severity === "high" && /Insecure Set-Cookie/.test(f.title))).toBe(true);
  });
});

describe("missingHeaderFindings", () => {
  const obs = (headers: Record<string, string>): RouteObservation => ({ status: 200, durationMs: 1, headers });

  it("flags all four when the response has no hardening (https)", () => {
    const f = missingHeaderFindings("/", obs({}), true);
    const titles = f.map((x) => x.title);
    expect(titles).toEqual([
      "Missing Content-Security-Policy",
      "Missing X-Content-Type-Options: nosniff",
      "Missing clickjacking protection",
      "Missing Strict-Transport-Security (HSTS)",
    ]);
    expect(f.every((x) => x.category === "security")).toBe(true);
  });

  it("does NOT flag HSTS on a non-https origin", () => {
    const f = missingHeaderFindings("/", obs({}), false);
    expect(f.map((x) => x.title)).not.toContain("Missing Strict-Transport-Security (HSTS)");
  });

  it("accepts CSP frame-ancestors as clickjacking protection and stays silent when hardened", () => {
    const f = missingHeaderFindings("/", obs({
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "strict-transport-security": "max-age=63072000",
    }), true);
    expect(f).toHaveLength(0);
  });
});

describe("computeCoverage", () => {
  const ok = (path: string, auth: ScanRouteSpec["auth"], status = 200): { spec: ScanRouteSpec; obs: RouteObservation } => ({
    spec: { path, journey: path, auth },
    obs: { status, durationMs: 1 },
  });
  const netErr = (path: string, auth: ScanRouteSpec["auth"]): { spec: ScanRouteSpec; obs: RouteObservation } => ({
    spec: { path, journey: path, auth },
    obs: { networkError: true, durationMs: 1 },
  });

  it("all routes responded -> ratio 1, no errors, public-only auth established", () => {
    const c = computeCoverage([ok("/a", "public"), ok("/b", "public")], { authProvided: false, authenticatedIntent: false });
    expect(c).toEqual({ attempted: 2, succeeded: 2, errored: 0, authRequired: false, authEstablished: true, coverageRatio: 1 });
  });

  it("a network error and a 5xx both count as errored (scanner never saw the route)", () => {
    const c = computeCoverage(
      [ok("/a", "public"), netErr("/b", "public"), ok("/c", "public", 503)],
      { authProvided: false, authenticatedIntent: false },
    );
    expect(c.attempted).toBe(3);
    expect(c.succeeded).toBe(1);
    expect(c.errored).toBe(2);
    expect(c.coverageRatio).toBeCloseTo(1 / 3);
  });

  it("auth required + authenticated session honored -> authEstablished true", () => {
    const c = computeCoverage([ok("/admin", "required", 200)], { authProvided: true, authenticatedIntent: true });
    expect(c.authRequired).toBe(true);
    expect(c.authEstablished).toBe(true);
  });

  it("auth required but NO session headers supplied -> authEstablished false", () => {
    const c = computeCoverage([ok("/admin", "required", 200)], { authProvided: false, authenticatedIntent: false });
    expect(c.authRequired).toBe(true);
    expect(c.authEstablished).toBe(false);
  });

  it("auth required, authenticated crawl but protected route 401'd -> session not honored -> authEstablished false", () => {
    const c = computeCoverage([ok("/admin", "required", 401)], { authProvided: true, authenticatedIntent: true });
    expect(c.authEstablished).toBe(false);
  });

  it("auth required, authenticated crawl but protected route bounced to login -> authEstablished false", () => {
    const c = computeCoverage(
      [{ spec: { path: "/admin", journey: "x", auth: "required" }, obs: { status: 302, location: "/login", durationMs: 1 } }],
      { authProvided: true, authenticatedIntent: true },
    );
    expect(c.authEstablished).toBe(false);
  });

  it("nothing attempted -> ratio 0, not NaN", () => {
    expect(computeCoverage([], { authProvided: false, authenticatedIntent: false }).coverageRatio).toBe(0);
  });
});

describe("scanPlatform coverage", () => {
  const SECURE: Record<string, string> = {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=63072000",
  };
  const mkRes = (status: number, location?: string) => {
    const h = new Headers(SECURE);
    if (location) h.set("location", location);
    return { status, headers: h } as unknown as Response;
  };

  it("a fully-reachable scan reports ratio 1 and no errored routes", async () => {
    const fetchImpl = jest.fn(async () => mkRes(200)) as unknown as typeof fetch;
    const res = await scanPlatform({
      workspaceId: "ws-1", platform: "t", baseUrl: "https://demo.example.com", fetchImpl,
      routes: [{ path: "/a", journey: "A", auth: "public" }, { path: "/b", journey: "B", auth: "public" }],
    });
    expect(res.coverage).toMatchObject({ attempted: 2, succeeded: 2, errored: 0, coverageRatio: 1 });
  });

  it("an unreachable route degrades coverage below 1", async () => {
    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/b")) throw new Error("network");
      return mkRes(200);
    }) as unknown as typeof fetch;
    const res = await scanPlatform({
      workspaceId: "ws-1", platform: "t", baseUrl: "https://demo.example.com", fetchImpl,
      routes: [{ path: "/a", journey: "A", auth: "public" }, { path: "/b", journey: "B", auth: "public" }],
    });
    expect(res.coverage!.errored).toBe(1);
    expect(res.coverage!.coverageRatio).toBe(0.5);
  });

  it("authenticated crawl with headers honored marks authEstablished true", async () => {
    const fetchImpl = jest.fn(async () => mkRes(200)) as unknown as typeof fetch;
    const res = await scanPlatform({
      workspaceId: "ws-1", platform: "t", baseUrl: "https://demo.example.com", fetchImpl,
      authenticated: true, headers: { cookie: "session=x" },
      routes: [{ path: "/admin", journey: "Admin", auth: "required" }],
    });
    expect(res.coverage).toMatchObject({ authRequired: true, authEstablished: true });
  });
});

describe("cookieAndCorsFindings", () => {
  const obs = (headers: Record<string, string>): RouteObservation => ({ status: 200, durationMs: 1, headers });

  it("flags a session cookie missing HttpOnly/Secure/SameSite as high", () => {
    const f = cookieAndCorsFindings("/login", obs({ "set-cookie": "sid=x; Path=/" }), true);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].title).toContain("HttpOnly");
    expect(f[0].title).toContain("Secure");
    expect(f[0].title).toContain("SameSite");
  });

  it("stays silent on a fully-flagged cookie", () => {
    const f = cookieAndCorsFindings("/login", obs({ "set-cookie": "sid=x; Path=/; HttpOnly; Secure; SameSite=Lax" }), true);
    expect(f).toHaveLength(0);
  });

  it("flags ACAO:* + Allow-Credentials:true as critical (the only real cross-origin leak)", () => {
    const crit = cookieAndCorsFindings(
      "/api",
      obs({ "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }),
      true,
    );
    expect(crit[0]).toMatchObject({ severity: "critical", title: "CORS wildcard with credentials" });
  });

  it("rates ACAO:* (no credentials) by response type: medium for data, low for HTML/document", () => {
    // JSON data response -> medium (a site can read this data cross-origin).
    const dataF = cookieAndCorsFindings(
      "/api/items",
      obs({ "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" }),
      true,
    );
    expect(dataF[0]).toMatchObject({ severity: "medium", title: "CORS allows any origin on a data response (ACAO: *)" });

    // HTML page (the Vercel/CDN static default) -> low, not medium noise.
    const htmlF = cookieAndCorsFindings(
      "/dashboard",
      obs({ "access-control-allow-origin": "*", "content-type": "text/html; charset=utf-8" }),
      true,
    );
    expect(htmlF[0]).toMatchObject({ severity: "low", title: "CORS wildcard on a non-data response (ACAO: *)" });

    // Unknown/absent content-type -> treated as non-data (low), never assumed sensitive.
    const unknownF = cookieAndCorsFindings("/x", obs({ "access-control-allow-origin": "*" }), true);
    expect(unknownF[0]).toMatchObject({ severity: "low" });
  });
});
