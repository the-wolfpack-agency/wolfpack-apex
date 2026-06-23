/**
 * Contract tests for POST /api/admin/agents/[id]/baseline.
 *
 *   - unauthenticated -> 401 (gated on settings.manage_team).
 *   - agent missing in workspace -> 404 not_found (captureBaseline never runs).
 *   - happy path -> 201 { baseline } scoped to the caller's workspace.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
}));

const mockCaptureBaseline = jest.fn();
jest.mock("@/lib/agents/drift/store", () => ({
  captureBaseline: (...a: any[]) => mockCaptureBaseline(...a),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(),
  writeQuery: jest.fn(),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const AGENT = { id: "a_1", workspaceId: "default", name: "Scout", state: "active" };

const BASELINE = {
  agentId: "a_1",
  workspaceId: "default",
  metrics: { count: 120 },
  decisionCount: 120,
  capturedAt: "2026-06-19T00:00:00.000Z",
};

function mkReq(): any {
  return { url: "http://x/api/admin/agents/a_1/baseline", headers: new Headers() };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAgent.mockResolvedValue(AGENT);
  mockCaptureBaseline.mockResolvedValue(BASELINE);
});

describe("POST /api/admin/agents/[id]/baseline", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/agents/[id]/baseline/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockCaptureBaseline).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/baseline/route");
    await POST(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("404 when the agent does not exist in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/agents/[id]/baseline/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    expect(mockCaptureBaseline).not.toHaveBeenCalled();
  });

  it("201 returns { baseline } scoped to the caller's workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/baseline/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { baseline: { agentId: string; decisionCount: number } };
    expect(body.baseline.agentId).toBe("a_1");
    expect(body.baseline.decisionCount).toBe(120);
    expect(mockGetAgent).toHaveBeenCalledWith("a_1", "default");
    expect(mockCaptureBaseline).toHaveBeenCalledWith("a_1", "default");
  });
});
