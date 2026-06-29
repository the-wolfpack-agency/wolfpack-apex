/**
 * Engine politeness integration: prove the per-host cap holds when scanPlatform
 * crawls a large manifest, that a 429/503 triggers backoff (and the
 * platform.scan_throttled event), and - critically - that finding detection
 * output is UNCHANGED vs the pre-politeness behavior (the politeness layer is
 * purely additive: same RouteObservation -> same findings).
 *
 * Deterministic: injected fetch + fake clock + fake sleep, no real timers/network.
 */
import { scanPlatform } from "@/lib/platform-scan/engine";
import type { ScanRouteSpec } from "@/lib/platform-scan/types";

// trackEvent is fired by the engine's default onThrottle. Mock the analytics
// module so the throttle path is observable without a DB.
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));
import { trackEvent } from "@/lib/analytics";

const SECURE: Record<string, string> = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=63072000",
};
function mkRes(status: number, location?: string, extra: Record<string, string> = {}) {
  const h = new Headers({ ...SECURE, ...extra });
  if (location) h.set("location", location);
  return { status, headers: h } as unknown as Response;
}
function fakeTime(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, get current() { return t; } };
}

describe("scanPlatform politeness", () => {
  beforeEach(() => (trackEvent as jest.Mock).mockClear());

  it("BURST LOAD: a 40-route manifest never exceeds the per-host concurrency cap", async () => {
    const clk = fakeTime();
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => releases.push(() => r()));
      inFlight -= 1;
      return mkRes(200);
    }) as unknown as typeof fetch;

    const routes: ScanRouteSpec[] = Array.from({ length: 40 }, (_, i) => ({
      path: `/p${i}`,
      journey: `P${i}`,
      auth: "public",
    }));

    const scan = scanPlatform({
      workspaceId: "ws-1",
      platform: "wolfpack-auto",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes,
      politeness: { perHostConcurrency: 4, minGapMs: 0, now: clk.now, sleep: clk.sleep },
    });

    for (let guard = 0; guard < 300 && (fetchImpl as jest.Mock).mock.calls.length < 40; guard++) {
      releases.splice(0).forEach((r) => r());
      for (let f = 0; f < 6; f++) await Promise.resolve();
    }
    releases.splice(0).forEach((r) => r());
    const res = await scan;

    expect(maxInFlight).toBeLessThanOrEqual(4); // the cap held under burst
    expect(fetchImpl).toHaveBeenCalledTimes(40); // every route still probed
    expect(res.routeCount).toBe(40);
  });

  it("a 429 then 200 backs off, retries, and fires platform.scan_throttled", async () => {
    const clk = fakeTime();
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return call === 1 ? mkRes(429, undefined, { "retry-after": "3" }) : mkRes(200);
    }) as unknown as typeof fetch;

    const res = await scanPlatform({
      workspaceId: "ws-1",
      platform: "wolfpack-auto",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: [{ path: "/x", journey: "X", auth: "public" }],
      actor: { id: "u1", role: "admin" },
      politeness: { minGapMs: 0, now: clk.now, sleep: clk.sleep },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2); // retried after backing off
    // The eventual 200 means NO 429 finding remains (it backed off, didn't flag).
    expect(res.findings.filter((f) => /Rate limited/.test(f.title))).toHaveLength(0);
    expect(trackEvent).toHaveBeenCalledWith(
      "platform.scan_throttled",
      "u1",
      "admin",
      expect.objectContaining({ platform: "wolfpack-auto", host: "demo.example.com", reason: "429", retry_after_ms: 3000 }),
    );
  });

  it("attributes throttling to a system actor when no actor is supplied", async () => {
    const clk = fakeTime();
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return call === 1 ? mkRes(503) : mkRes(200);
    }) as unknown as typeof fetch;

    await scanPlatform({
      workspaceId: "ws-1",
      platform: "p",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: [{ path: "/x", journey: "X", auth: "public" }],
      politeness: { minGapMs: 0, now: clk.now, sleep: clk.sleep },
    });

    expect(trackEvent).toHaveBeenCalledWith(
      "platform.scan_throttled",
      "system",
      "system",
      expect.objectContaining({ reason: "503" }),
    );
  });

  it("a persistent 429 (retries exhausted) STILL surfaces the rate-limited finding (detection preserved)", async () => {
    const clk = fakeTime();
    const fetchImpl = jest.fn(async () => mkRes(429, undefined, { "retry-after": "1" })) as unknown as typeof fetch;

    const res = await scanPlatform({
      workspaceId: "ws-1",
      platform: "p",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: [{ path: "/x", journey: "X", auth: "public" }],
      politeness: { maxRetries: 2, minGapMs: 0, now: clk.now, sleep: clk.sleep },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    const rl = res.findings.find((f) => /Rate limited/.test(f.title));
    expect(rl).toMatchObject({ severity: "medium", category: "performance" });
  });
});

describe("finding detection is UNCHANGED by the politeness layer", () => {
  // The exact mixed manifest from the baseline engine.test.ts crawl test. We
  // assert the SAME findings come out with the politeness layer in the path -
  // the additive change must not alter detection.
  const ROUTES: ScanRouteSpec[] = [
    { path: "/inventory", journey: "Public inventory", auth: "public" },
    { path: "/admin", journey: "Dashboard", auth: "required" },
    { path: "/admin/leads", journey: "Leads", auth: "required" },
    { path: "/admin/gone", journey: "Removed", auth: "required" },
  ];
  const handler = (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/inventory")) return mkRes(200);
    if (u.endsWith("/admin")) return mkRes(302, "/admin/login");
    if (u.endsWith("/admin/leads")) return mkRes(500);
    throw new Error("network");
  };

  async function run(politeness?: Record<string, unknown>) {
    const clk = fakeTime();
    const fetchImpl = jest.fn(async (url: string | URL | Request) => handler(url)) as unknown as typeof fetch;
    return scanPlatform({
      workspaceId: "ws-1",
      platform: "wolfpack-auto",
      baseUrl: "https://demo.example.com",
      fetchImpl,
      routes: ROUTES,
      politeness: { now: clk.now, sleep: clk.sleep, minGapMs: 0, ...politeness },
    });
  }

  it("produces the identical findings/coverage as the documented baseline", async () => {
    const res = await run();
    // Matches engine.test.ts "crawls every route" expectations exactly.
    expect(res.routeCount).toBe(4);
    expect(res.okCount).toBe(2);
    expect(res.findings).toHaveLength(2);
    expect(res.findings.map((f) => f.category).sort()).toEqual(["bug", "bug"]);
    expect(res.coverage).toMatchObject({ attempted: 4, succeeded: 2, errored: 2 });
  });

  it("output is byte-identical across two different politeness configs (timing-invariant)", async () => {
    const a = await run({ perHostConcurrency: 1, minGapMs: 50 });
    const b = await run({ perHostConcurrency: 8, minGapMs: 0 });
    // evidence.durationMs is the MEASURED request time (0 vs 1ms depending on
    // load); it is the one legitimately timing-variant field, so normalize it
    // out. The point of this test is that DETECTION (route/severity/category/
    // title/detail/status) is invariant to politeness, not the wall-clock.
    // Comparing it raw made this assertion flaky under CI load.
    const stripTiming = (findings: typeof a.findings) =>
      findings.map((f) => ({ ...f, evidence: { ...f.evidence, durationMs: 0 } }));
    expect(JSON.stringify(stripTiming(a.findings))).toEqual(
      JSON.stringify(stripTiming(b.findings)),
    );
    expect(JSON.stringify(a.coverage)).toEqual(JSON.stringify(b.coverage));
  });
});
