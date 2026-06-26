/**
 * GET /api/cron/integration-health — the nightly sweep entry point.
 * Pins: the cron bearer path runs without a session; the user path requires
 * settings.manage_team; an unauthorized request is refused; the sweep summary +
 * health_sweep event are returned; a thrown sweep is swallowed to a 200 so the
 * cron monitor stays green.
 */
const mockSweepAll = jest.fn();
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("@/lib/health/integration-probes", () => ({ sweepAllWorkspaces: (...a: unknown[]) => mockSweepAll(...a) }));
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/integration-health/route";

const SECRET = "cron-secret-xyz";
function get(headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/cron/integration-health", { headers });
}

let savedSecret: string | undefined;
beforeAll(() => { savedSecret = process.env.CRON_SECRET; process.env.CRON_SECRET = SECRET; });
afterAll(() => { if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret; });
beforeEach(() => {
  jest.clearAllMocks();
  mockSweepAll.mockResolvedValue({ workspaces: 2, probes: 8, drifted: ["salesforce.deal"] });
});

it("the cron bearer path runs the sweep without a session and emits the summary event", async () => {
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, workspaces: 2, probes: 8 });
  expect(mockRequireCapability).not.toHaveBeenCalled(); // bearer bypasses the session gate
  expect(mockTrackEvent).toHaveBeenCalledWith("integration.health_sweep", "cron", "system", expect.objectContaining({ workspaces: 2, drift_count: 1 }));
});

it("the user path requires settings.manage_team and runs on success", async () => {
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  const res = await GET(get());
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  expect(res.status).toBe(200);
  expect(mockSweepAll).toHaveBeenCalled();
});

it("refuses an unauthorized request (no bearer, no capability)", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await GET(get());
  expect(res.status).toBe(403);
  expect(mockSweepAll).not.toHaveBeenCalled();
});

it("never 500s: a thrown sweep returns a zeroed 200", async () => {
  mockSweepAll.mockRejectedValue(new Error("db down"));
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, workspaces: 0, probes: 0 });
});
