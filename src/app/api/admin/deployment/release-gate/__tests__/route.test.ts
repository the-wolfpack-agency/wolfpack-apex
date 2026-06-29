/**
 * Contract for GET /api/admin/deployment/release-gate.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403 on failure; happy
 * path -> 200 { ok:true, gate }; fires deploy.release_gate_viewed with the
 * blocking_count; honest-degrade passes through. getReleaseGate is mocked so
 * this is a pure route contract.
 */
const mockGetGate = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/deploy/release-gate", () => ({
  getReleaseGate: (...a: unknown[]) => mockGetGate(...a),
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
});

describe("GET /api/admin/deployment/release-gate", () => {
  it("returns 200 { ok:true, gate } and fires release_gate_viewed with blocking_count", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, gate: GATE });
    expect(mockTrack).toHaveBeenCalledWith(
      "deploy.release_gate_viewed",
      "admin-1",
      "cto",
      expect.objectContaining({ blocking_count: 2 }),
    );
  });

  it("passes the degraded detail through and reports it to analytics", async () => {
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
    expect(mockTrack).toHaveBeenCalledWith(
      "deploy.release_gate_viewed",
      "admin-1",
      "cto",
      expect.objectContaining({ blocking_count: 0, degraded: "Could not reach GitHub" }),
    );
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
