/**
 * Contract tests for the agent principals collection API.
 *
 *   POST /api/admin/agents: create/invite an agent (201 + one-time secret + audit;
 *     401 / 403 gate; 400 on bad input; 403 on a lower admin minting a top-privilege
 *     agent; 409 on a name conflict).
 *   GET /api/admin/agents: list the workspace's agents (200 shape).
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockCreateAgent = jest.fn();
const mockListAgents = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  createAgent: (...a: any[]) => mockCreateAgent(...a),
  listAgents: (...a: any[]) => mockListAgents(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };
const OPS = { id: "u_ops", email: "ops@x.com", role: "ops", workspaceId: "ws_1" };

function mkReq(body: unknown): any {
  return {
    url: "http://x/api/admin/agents",
    headers: new Headers(),
    json: async () => body,
  };
}

const SAMPLE_AGENT = {
  id: "a_1",
  workspaceId: "default",
  name: "Researcher",
  role: "ops",
  ownerUserId: "u_cto",
  state: "invited",
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

describe("POST /api/admin/agents", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(401);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(403);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("201 returns agent + one-time onboarding_secret and records an audit entry", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: SAMPLE_AGENT,
      onboardingSecret: "deadbeef".repeat(8),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", description: "reads papers" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: { id: string };
      onboarding_secret: string;
    };
    expect(body.agent.id).toBe("a_1");
    expect(body.onboarding_secret).toBe("deadbeef".repeat(8));

    // owner defaults to the caller and workspace comes off the caller.
    const arg = mockCreateAgent.mock.calls[0][0];
    expect(arg.ownerUserId).toBe("u_cto");
    expect(arg.workspaceId).toBe("default");
    expect(arg.createdBy).toBe("u_cto");

    // Minting a principal is a capability grant: it is hash-chained.
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("agent.created");
    expect(audit.resourceType).toBe("agent");
    expect(audit.resourceId).toBe("a_1");
    expect(audit.afterState).toMatchObject({
      role: "ops",
      owner_user_id: "u_cto",
      identity_provider: "local",
    });
  });

  it("uses owner_user_id from the body when provided", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    const { POST } = await import("@/app/api/admin/agents/route");
    await POST(mkReq({ name: "Researcher", role: "ops", owner_user_id: "u_owner" }));
    expect(mockCreateAgent.mock.calls[0][0].ownerUserId).toBe("u_owner");
  });

  it("400 on an invalid role", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "wizard" }));
    expect(res.status).toBe(400);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("400 on an empty name", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "   ", role: "ops" }));
    expect(res.status).toBe(400);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("403 when a non-cto/ceo admin tries to mint a cto agent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: OPS });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Overlord", role: "cto" }));
    expect(res.status).toBe(403);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("allows a cto to mint a cto agent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: { ...SAMPLE_AGENT, role: "cto" },
      onboardingSecret: "x",
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Overlord", role: "cto" }));
    expect(res.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("409 when the agent name is already taken in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "instinct_agents_ws_name"'),
    );
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name_taken");
  });
});

describe("GET /api/admin/agents", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/route");
    const res = await GET(mkReq({}));
    expect(res.status).toBe(403);
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("200 returns the workspace's agents", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockListAgents.mockResolvedValue([SAMPLE_AGENT]);
    const { GET } = await import("@/app/api/admin/agents/route");
    const res = await GET(mkReq({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe("a_1");
    // workspace-scoped to the caller.
    expect(mockListAgents).toHaveBeenCalledWith("default");
  });
});
