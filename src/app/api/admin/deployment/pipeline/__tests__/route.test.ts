/**
 * Contract for GET /api/admin/deployment/pipeline.
 *
 * Proves: capability gate (settings.manage_team) -> 401/403; happy path -> 200
 * { ok, pipelines, servingSha, degraded } + fires deploy.pipeline_viewed
 * (scope=fleet); a thrown orchestrator degrades to 200 empty+degraded (never
 * 500). The pipeline reader is mocked.
 */
const mockGetPipelines = jest.fn();
const mockTrack = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/deploy/pipeline", () => ({
  getDeploymentPipelines: (...a: unknown[]) => mockGetPipelines(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/deployment/pipeline/route";

function get() {
  return GET(new NextRequest("http://localhost/api/admin/deployment/pipeline"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "cto", workspaceId: "ws-1" } });
  mockGetPipelines.mockResolvedValue({
    pipelines: [{ id: "sha1", status: "deployed" }],
    servingSha: "sha1",
    checkedAt: "t",
    degraded: [],
  });
});

describe("GET /api/admin/deployment/pipeline", () => {
  it("returns 200 with the report and fires deploy.pipeline_viewed(fleet)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.pipelines).toHaveLength(1);
    expect(json.servingSha).toBe("sha1");
    const ev = mockTrack.mock.calls[0];
    expect(ev[0]).toBe("deploy.pipeline_viewed");
    expect(ev[3]).toMatchObject({ scope: "fleet", pipeline_count: 1, degraded: false });
  });

  it("scopes to the workspace and fires deploy.agent_regression_correlated when the live deploy has impact", async () => {
    mockGetPipelines.mockResolvedValue({
      pipelines: [
        {
          id: "sha1", live: true, commitSha: "sha1", status: "deployed",
          agentImpact: { regressionCount: 2, since: "2026-07-10T00:00:00Z", regressions: [] },
        },
      ],
      servingSha: "sha1", checkedAt: "t", degraded: [],
    });
    const res = await get();
    expect(res.status).toBe(200);
    // orchestrator scoped to the caller's workspace
    expect(mockGetPipelines.mock.calls[0][0]).toMatchObject({ workspaceId: "ws-1" });
    // both events fired (viewed + correlated)
    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events).toContain("deploy.pipeline_viewed");
    expect(events).toContain("deploy.agent_regression_correlated");
    const corr = mockTrack.mock.calls.find((c) => c[0] === "deploy.agent_regression_correlated")!;
    expect(corr[3]).toMatchObject({ commit_sha: "sha1", regression_count: 2 });
  });

  it("does NOT fire the correlation event when the live deploy has no regressions", async () => {
    mockGetPipelines.mockResolvedValue({
      pipelines: [{ id: "sha1", live: true, commitSha: "sha1", status: "deployed", agentImpact: { regressionCount: 0, since: "t", regressions: [] } }],
      servingSha: "sha1", checkedAt: "t", degraded: [],
    });
    await get();
    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events).not.toContain("deploy.agent_regression_correlated");
  });

  it("propagates the capability failure (401/403)", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await get();
    expect(res.status).toBe(403);
    expect(mockGetPipelines).not.toHaveBeenCalled();
  });

  it("degrades to 200 empty+degraded when the orchestrator throws (never 500)", async () => {
    mockGetPipelines.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pipelines).toEqual([]);
    expect(json.degraded.length).toBeGreaterThan(0);
  });
});
