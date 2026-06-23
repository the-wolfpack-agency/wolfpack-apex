/**
 * Contract tests for POST /api/admin/agents/[id]/drift-check.
 *
 *   - unauthenticated -> 401 (gated on settings.manage_team).
 *   - agent missing in workspace -> 404 not_found (runDriftCheck never runs).
 *   - happy path (no pause) -> 200 { result }, NO audit row.
 *   - happy path (auto-paused) -> 200 { result } + recordAudit("agent.auto_paused").
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

const mockRunDriftCheck = jest.fn();
jest.mock("@/lib/agents/drift/store", () => ({
  runDriftCheck: (...a: any[]) => mockRunDriftCheck(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ip: "1.2.3.4", user_agent: "test" }),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(),
  writeQuery: jest.fn(),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const AGENT = { id: "a_1", workspaceId: "default", name: "Scout", state: "active" };

const STABLE = {
  verdict: "stable",
  score: 0.1,
  components: { blockRateDelta: 0, tierDistance: 0, toolDistance: 0 },
  shouldPause: false,
  action: "none",
  recent: { count: 50 },
};

const PAUSED = {
  verdict: "critical",
  score: 0.92,
  components: { blockRateDelta: 0.4, tierDistance: 0.3, toolDistance: 0.2 },
  shouldPause: true,
  action: "paused",
  recent: { count: 50 },
};

function mkReq(): any {
  return { url: "http://x/api/admin/agents/a_1/drift-check", headers: new Headers() };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAgent.mockResolvedValue(AGENT);
  mockRunDriftCheck.mockResolvedValue(STABLE);
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/agents/[id]/drift-check", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockRunDriftCheck).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    await POST(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("404 when the agent does not exist in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    expect(mockRunDriftCheck).not.toHaveBeenCalled();
  });

  it("200 returns { result } and does NOT audit when no pause", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { verdict: string; action: string } };
    expect(body.result.verdict).toBe("stable");
    expect(body.result.action).toBe("none");
    expect(mockRunDriftCheck).toHaveBeenCalledWith("a_1", "default");
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("200 + audits agent.auto_paused when the check auto-pauses the agent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockRunDriftCheck.mockResolvedValue(PAUSED);
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { action: string } };
    expect(body.result.action).toBe("paused");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const arg = mockRecordAudit.mock.calls[0][0];
    expect(arg.action).toBe("agent.auto_paused");
    expect(arg.resourceType).toBe("agent");
    expect(arg.resourceId).toBe("a_1");
    expect(arg.afterState).toEqual({ verdict: "critical", score: 0.92 });
  });

  it("still returns 200 when the audit write fails (best-effort)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockRunDriftCheck.mockResolvedValue(PAUSED);
    mockRecordAudit.mockRejectedValue(new Error("audit down"));
    const { POST } = await import("@/app/api/admin/agents/[id]/drift-check/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { action: string } };
    expect(body.result.action).toBe("paused");
  });
});
