/**
 * Contract for GET /api/admin/agents/model-regressions.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403 on failure; happy
 * path -> 200 { ok:true, standings, regressions } scoped to the caller's
 * workspace; a store throw degrades to 200 with empty arrays (never 500, never
 * blanks the agents page). The store reads are mocked.
 */
const mockStandings = jest.fn();
const mockRegressions = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => mockAuth(),
}));
jest.mock("@/lib/agents/evals/store", () => ({
  getFleetModelStandings: (...a: unknown[]) => mockStandings(...a),
  listModelRegressions: (...a: unknown[]) => mockRegressions(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/agents/model-regressions/route";

function get() {
  return GET(
    new NextRequest("http://localhost/api/admin/agents/model-regressions"),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({
    ok: true,
    user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
  });
  mockStandings.mockResolvedValue([
    {
      agentId: "agt-A",
      agentName: "Alpha",
      verdict: "regressed",
      candidateModel: "z",
      baselineModel: "y",
      candidateSuccessRate: 0.5,
      baselineSuccessRate: 0.9,
      delta: -0.4,
      candidateSamples: 20,
      baselineSamples: 20,
    },
  ]);
  mockRegressions.mockResolvedValue([]);
});

describe("GET /api/admin/agents/model-regressions", () => {
  it("returns 200 { ok, standings, regressions } scoped to the workspace", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.standings).toHaveLength(1);
    expect(json.standings[0].verdict).toBe("regressed");
    expect(json.regressions).toEqual([]);
    // both reads scoped to the caller's workspace
    expect(mockStandings).toHaveBeenCalledWith("ws-1");
    expect(mockRegressions).toHaveBeenCalledWith("ws-1", 20);
  });

  it("propagates the capability failure response (401/403)", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
    });
    mockAuth = async () => ({ ok: false, response: denied });
    const res = await get();
    expect(res.status).toBe(403);
    expect(mockStandings).not.toHaveBeenCalled();
  });

  it("degrades to 200 with empty arrays when the store throws (never 500)", async () => {
    mockStandings.mockRejectedValue(new Error("db down"));
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, standings: [], regressions: [] });
  });
});
