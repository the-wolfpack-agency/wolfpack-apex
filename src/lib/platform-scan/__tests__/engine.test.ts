/**
 * The scan engine's classification battery (the heart of the feature) + the
 * crawl aggregation. classify() is pure, so every branch is asserted directly;
 * scanPlatform() is exercised with an injected fetch (no network).
 */
import { classify, scanPlatform } from "@/lib/platform-scan/engine";
import type { ScanRouteSpec } from "@/lib/platform-scan/types";

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

  it("carries the raw signal as evidence for reviewer verification", () => {
    const f = classify(REQ, { status: 500, location: null, durationMs: 123.7 }, SLOW)[0];
    expect(f.evidence).toMatchObject({ status: 500, durationMs: 124, expectedAuth: "required" });
  });
});

describe("scanPlatform", () => {
  function mkRes(status: number, location?: string) {
    return { status, headers: { get: (h: string) => (h.toLowerCase() === "location" ? location ?? null : null) } } as unknown as Response;
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
});
