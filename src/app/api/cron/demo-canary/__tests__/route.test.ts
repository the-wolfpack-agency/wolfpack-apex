/**
 * GET /api/cron/demo-canary — demo-login canary sweep contract tests.
 * Pins:
 *   - env unset → INERT 200 { skipped:true, targets:0 }, no canary run, no events
 *   - a healthy run → canary.demo_run per target, NO demo_failed, NO alert
 *   - an unhealthy target → canary.demo_failed + high-priority admin notify
 *   - cron bearer path runs without a session; capability path consults the guard
 *   - no auth (no bearer, no capability) → 401, canary not run
 *   - a thrown sweep is swallowed to a zeroed 200 (never 500)
 */

const mockRunDemoCanary = jest.fn();
const mockParseCanaryTargets = jest.fn();
const mockRequireCapability = jest.fn();
const mockEffectiveCaps = jest.fn();
const mockTrackEvent = jest.fn();
const mockNotify = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/platform-scan/canary", () => ({
  runDemoCanary: (...a: unknown[]) => mockRunDemoCanary(...a),
  parseCanaryTargets: (...a: unknown[]) => mockParseCanaryTargets(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
  effectiveCapabilitiesFor: (...a: unknown[]) => mockEffectiveCaps(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...a: unknown[]) => mockNotify(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/demo-canary/route";

const SECRET = "cron-secret-xyz";
function get(headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/cron/demo-canary", { headers });
}

const HEALTHY = {
  name: "demo",
  loginOk: true,
  scanOk: true,
  findingCount: 3,
  healthy: true,
};
const UNHEALTHY = {
  name: "demo",
  loginOk: false,
  scanOk: false,
  findingCount: 0,
  healthy: false,
  reason: "login failed",
};

let savedSecret: string | undefined;
let savedTargets: string | undefined;
beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  savedTargets = process.env.DEMO_CANARY_TARGETS;
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
  if (savedTargets === undefined) delete process.env.DEMO_CANARY_TARGETS;
  else process.env.DEMO_CANARY_TARGETS = savedTargets;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DEMO_CANARY_TARGETS = '[{"name":"demo"}]';
  // Default: one configured target, parsed.
  mockParseCanaryTargets.mockReturnValue([{ name: "demo" }]);
  // Default: one active admin who holds settings.manage_team.
  mockSafeQuery.mockResolvedValue({
    rows: [{ id: "admin-1", email: "a@x.test", name: "Admin", role: "cto", workspace_id: "ws-1" }],
  });
  mockEffectiveCaps.mockResolvedValue({ capabilities: new Set(["settings.manage_team"]) });
  mockNotify.mockResolvedValue({ id: "notif-1" });
  mockRunDemoCanary.mockResolvedValue([HEALTHY]);
  // Cron path used by default unless a test overrides.
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
});

const bearer = { authorization: `Bearer ${SECRET}` };

describe("GET /api/cron/demo-canary", () => {
  it("is INERT when DEMO_CANARY_TARGETS is unset/empty", async () => {
    mockParseCanaryTargets.mockReturnValue([]);
    const res = await GET(get(bearer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: boolean; targets: number };
    expect(body).toEqual({ ok: true, skipped: true, targets: 0 });
    expect(mockRunDemoCanary).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("a healthy run emits canary.demo_run and NO alert", async () => {
    mockRunDemoCanary.mockResolvedValue([HEALTHY]);
    const res = await GET(get(bearer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; targets: number; healthy: number; unhealthy: number };
    expect(body).toEqual({ ok: true, targets: 1, healthy: 1, unhealthy: 0 });

    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("canary.demo_run");
    expect(events).not.toContain("canary.demo_failed");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("an unhealthy target emits canary.demo_failed AND notifies an admin (high priority)", async () => {
    mockRunDemoCanary.mockResolvedValue([UNHEALTHY]);
    const res = await GET(get(bearer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { healthy: number; unhealthy: number };
    expect(body.healthy).toBe(0);
    expect(body.unhealthy).toBe(1);

    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("canary.demo_run");
    expect(events).toContain("canary.demo_failed");

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const notifyArg = mockNotify.mock.calls[0][0];
    expect(notifyArg.priority).toBe("high");
    expect(notifyArg.userId).toBe("admin-1");
    expect(notifyArg.source).toBe("demo-canary");
  });

  it("does not notify a non-admin member", async () => {
    mockRunDemoCanary.mockResolvedValue([UNHEALTHY]);
    mockEffectiveCaps.mockResolvedValue({ capabilities: new Set([]) });
    await GET(get(bearer));
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("cron bearer path runs without consulting the capability guard", async () => {
    await GET(get(bearer));
    expect(mockRequireCapability).not.toHaveBeenCalled();
    expect(mockRunDemoCanary).toHaveBeenCalledTimes(1);
  });

  it("user path consults settings.manage_team and runs on success", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: { id: "u_cto", role: "cto" },
    });
    const res = await GET(get()); // no bearer → falls to capability path
    expect(res.status).toBe(200);
    expect(mockRequireCapability.mock.calls[0][1]).toBe("settings.manage_team");
    expect(mockRunDemoCanary).toHaveBeenCalledTimes(1);
  });

  it("401 with no bearer and no capability; canary not run", async () => {
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(mockRunDemoCanary).not.toHaveBeenCalled();
  });

  it("401 with a wrong bearer and no capability", async () => {
    const res = await GET(get({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(mockRunDemoCanary).not.toHaveBeenCalled();
  });

  it("returns a zeroed 200 (never 500) on a thrown sweep", async () => {
    mockRunDemoCanary.mockRejectedValue(new Error("db unreachable"));
    const res = await GET(get(bearer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: boolean; targets: number };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.targets).toBe(0);
  });
});
