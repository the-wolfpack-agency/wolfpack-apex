/**
 * Contract tests for the single agent principal API.
 *
 *   GET /api/admin/agents/[id]:   404 when missing, 200 when found, 401/403 gate.
 *   PATCH /api/admin/agents/[id]: lifecycle transition + audit, 400 on a bad
 *     action, 404 when the agent does not exist.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockGetAgent = jest.fn();
const mockSetAgentState = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
  setAgentState: (...a: any[]) => mockSetAgentState(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(body?: unknown): any {
  return {
    url: "http://x/api/admin/agents/a_1",
    headers: new Headers(),
    json: async () => body ?? {},
  };
}

function ctx(id = "a_1") {
  return { params: Promise.resolve({ id }) };
}

const SAMPLE_AGENT = {
  id: "a_1",
  workspaceId: "default",
  name: "Researcher",
  role: "ops",
  ownerUserId: "u_cto",
  state: "active",
  identityProvider: "local",
  externalSubject: null,
  scanStatus: "pending",
  description: null,
  createdBy: "u_cto",
  createdAt: "2026-06-19T00:00:00.000Z",
  activatedAt: null,
  lastSeenAt: null,
  revokedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "audit_1", seq: 1, entryHash: "h" });
});

describe("GET /api/admin/agents/[id]", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/route");
    const res = await GET(mkReq(), ctx());
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/route");
    const res = await GET(mkReq(), ctx());
    expect(res.status).toBe(403);
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it("404 when the agent does not exist in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(null);
    const { GET } = await import("@/app/api/admin/agents/[id]/route");
    const res = await GET(mkReq(), ctx("missing"));
    expect(res.status).toBe(404);
    expect(mockGetAgent).toHaveBeenCalledWith("missing", "default");
  });

  it("200 returns the agent when found", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(SAMPLE_AGENT);
    const { GET } = await import("@/app/api/admin/agents/[id]/route");
    const res = await GET(mkReq(), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { id: string } };
    expect(body.agent.id).toBe("a_1");
  });
});

describe("PATCH /api/admin/agents/[id]", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { PATCH } = await import("@/app/api/admin/agents/[id]/route");
    const res = await PATCH(mkReq({ action: "revoke" }), ctx());
    expect(res.status).toBe(403);
    expect(mockSetAgentState).not.toHaveBeenCalled();
  });

  it("400 on an unknown action", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/agents/[id]/route");
    const res = await PATCH(mkReq({ action: "explode" }), ctx());
    expect(res.status).toBe(400);
    expect(mockSetAgentState).not.toHaveBeenCalled();
  });

  it("revoke transitions to the revoked state and writes an audit entry", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSetAgentState.mockResolvedValue({ ...SAMPLE_AGENT, state: "revoked" });
    const { PATCH } = await import("@/app/api/admin/agents/[id]/route");
    const res = await PATCH(mkReq({ action: "revoke" }), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { state: string } };
    expect(body.agent.state).toBe("revoked");

    // The action maps to the revoked lifecycle state, scoped to the workspace.
    expect(mockSetAgentState).toHaveBeenCalledWith("a_1", "default", "revoked", {
      userId: "u_cto",
      role: "cto",
    });

    // A lifecycle change is security-relevant: hash-chained.
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("agent.lifecycle_changed");
    expect(audit.resourceType).toBe("agent");
    expect(audit.afterState).toMatchObject({ action: "revoke", state: "revoked" });
  });

  it("maps pause -> paused and resume -> active", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSetAgentState.mockResolvedValue({ ...SAMPLE_AGENT, state: "paused" });
    const { PATCH } = await import("@/app/api/admin/agents/[id]/route");

    await PATCH(mkReq({ action: "pause" }), ctx());
    expect(mockSetAgentState.mock.calls[0][2]).toBe("paused");

    mockSetAgentState.mockResolvedValue({ ...SAMPLE_AGENT, state: "active" });
    await PATCH(mkReq({ action: "resume" }), ctx());
    expect(mockSetAgentState.mock.calls[1][2]).toBe("active");
  });

  it("404 when the agent does not exist", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSetAgentState.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/admin/agents/[id]/route");
    const res = await PATCH(mkReq({ action: "revoke" }), ctx("missing"));
    expect(res.status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
