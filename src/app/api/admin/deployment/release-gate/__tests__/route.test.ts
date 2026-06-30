/**
 * Contract for GET /api/admin/deployment/release-gate.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403 on failure; happy
 * path -> 200 { ok:true, gate, plan }; fires deploy.release_gate_viewed with the
 * blocking_count AND deploy.merge_plan_computed with the order summary; the
 * recommended order is computed from the ready changes' shared files; honest
 * degrade passes through and skips the plan. getReleaseGate +
 * fetchChangedFilesByPr are mocked; the pure planner runs for real.
 */
const mockGetGate = jest.fn();
const mockGetFiles = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/deploy/release-gate", () => ({
  getReleaseGate: (...a: unknown[]) => mockGetGate(...a),
  fetchChangedFilesByPr: (...a: unknown[]) => mockGetFiles(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/deployment/release-gate/route";

const GATE = {
  productionBranch: "main",
  checkedAt: "2026-06-29T12:00:00.000Z",
  blocking: [
    { number: 1, title: "x", url: "u", author: "nick", headSha: "s", state: "awaiting_approval", reason: "Waiting on your approval", ageHours: 2 },
    { number: 2, title: "y", url: "u", author: "joe", headSha: "s2", state: "checks_running", reason: "Tests are still running", ageHours: 1 },
  ],
};

function get() {
  return GET(new NextRequest("http://localhost/api/admin/deployment/release-gate"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "cto", workspaceId: "ws-1" } });
  mockGetGate.mockResolvedValue({ ...GATE });
  mockGetFiles.mockResolvedValue({ filesByPr: {} });
});

describe("GET /api/admin/deployment/release-gate", () => {
  it("returns 200 { ok, gate, plan } and fires both analytics events", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.gate).toEqual(GATE);
    // A plan is computed (the two blocking changes are listed, none ready).
    expect(json.plan).not.toBeNull();
    expect(json.plan.readyCount).toBe(0);
    expect(json.plan.steps).toHaveLength(2);
    // No ready changes -> no file fetch needed.
    expect(mockGetFiles).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("deploy.release_gate_viewed", "admin-1", "cto", expect.objectContaining({ blocking_count: 2 }));
    expect(mockTrack).toHaveBeenCalledWith("deploy.merge_plan_computed", "admin-1", "cto", expect.objectContaining({ ready_count: 0 }));
  });

  it("computes the recommended order from the ready changes' shared files", async () => {
    mockGetGate.mockResolvedValue({
      productionBranch: "main",
      checkedAt: "2026-06-29T12:00:00.000Z",
      blocking: [
        { number: 10, title: "a", url: "u", author: "n", headSha: "s", state: "ready_to_merge", reason: "Ready to promote", ageHours: 5 },
        { number: 11, title: "b", url: "u", author: "n", headSha: "s", state: "ready_to_merge", reason: "Ready to promote", ageHours: 1 },
      ],
    });
    mockGetFiles.mockResolvedValue({ filesByPr: { 10: ["src/lib/analytics.ts"], 11: ["src/lib/analytics.ts"] } });

    const res = await get();
    const json = await res.json();
    expect(mockGetFiles).toHaveBeenCalledWith([10, 11]);
    expect(json.plan.readyCount).toBe(2);
    expect(json.plan.hasOverlaps).toBe(true);
    const ordered = json.plan.steps.filter((s: { ready: boolean }) => s.ready);
    expect(ordered.map((s: { order: number }) => s.order)).toEqual([1, 2]);
    expect(ordered[1].rebaseAfter).toEqual([ordered[0].number]);
    expect(mockTrack).toHaveBeenCalledWith("deploy.merge_plan_computed", "admin-1", "cto", expect.objectContaining({ ready_count: 2, has_overlaps: true }));
  });

  it("passes the degraded detail through, skips the plan, and does not compute a merge plan", async () => {
    mockGetGate.mockResolvedValue({
      productionBranch: "main",
      checkedAt: "2026-06-29T12:00:00.000Z",
      blocking: [],
      degraded: { detail: "Could not reach GitHub" },
    });
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gate.degraded.detail).toBe("Could not reach GitHub");
    expect(json.plan).toBeNull();
    expect(mockGetFiles).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("deploy.release_gate_viewed", "admin-1", "cto", expect.objectContaining({ blocking_count: 0, degraded: "Could not reach GitHub" }));
    expect(mockTrack).not.toHaveBeenCalledWith("deploy.merge_plan_computed", expect.anything(), expect.anything(), expect.anything());
  });

  it("403s when the capability gate fails (no gate read, no track)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await get();
    expect(res.status).toBe(403);
    expect(mockGetGate).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockGetGate).not.toHaveBeenCalled();
  });
});
