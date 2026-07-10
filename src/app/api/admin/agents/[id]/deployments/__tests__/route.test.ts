/**
 * Contract for GET /api/admin/agents/[id]/deployments.
 *
 * Proves: capability gate -> 401/403; unknown agent -> 404 (from the source of
 * truth, never inferred); happy path -> 200 { ok, links, degraded } + fires
 * deploy.pipeline_viewed(scope=agent); a thrown reader degrades to 200 empty
 * (never 500). getAgent + the reader are mocked.
 */
const mockGetAgent = jest.fn();
const mockGetAgentPipelines = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/agents/store", () => ({ getAgent: (...a: unknown[]) => mockGetAgent(...a) }));
jest.mock("@/lib/deploy/pipeline", () => ({
  getAgentDeploymentPipelines: (...a: unknown[]) => mockGetAgentPipelines(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/agents/[id]/deployments/route";

function get(id = "agt-1") {
  return GET(new NextRequest(`http://localhost/api/admin/agents/${id}/deployments`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "cto", workspaceId: "ws-1" } });
  mockGetAgent.mockResolvedValue({ id: "agt-1", name: "Scout", ownerUserId: "u", state: "active" });
  mockGetAgentPipelines.mockResolvedValue({
    links: [{ prNumber: 42, stateAtTriage: "checks_failing", triagedAt: "t", pipeline: null, resolved: true }],
    degraded: [],
    checkedAt: "t",
  });
});

describe("GET /api/admin/agents/[id]/deployments", () => {
  it("returns 200 with the agent's deployment links + fires deploy.pipeline_viewed(agent)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.links).toHaveLength(1);
    const ev = mockTrack.mock.calls[0];
    expect(ev[0]).toBe("deploy.pipeline_viewed");
    expect(ev[3]).toMatchObject({ scope: "agent", pipeline_count: 1 });
  });

  it("404s when the agent does not exist (source of truth)", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect(mockGetAgentPipelines).not.toHaveBeenCalled();
  });

  it("propagates the capability failure (401/403)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it("degrades to 200 empty when the reader throws (never 500)", async () => {
    mockGetAgentPipelines.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.links).toEqual([]);
  });
});
