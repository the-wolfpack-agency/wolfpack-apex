/**
 * Contract tests for /api/admin/agents/[id]/connections (migration 183).
 *
 * GET:
 *   - 403 without settings.manage_team (returns auth.response).
 *   - 200 returns { bound, available }: bound = joined details of this agent's
 *     bound connections; available = active workspace connections NOT bound.
 * POST body { connectorName }:
 *   - 400 when connectorName is missing.
 *   - 200 { ok, bound } binds + returns the refreshed bound list + audits.
 * DELETE body { connectorName }:
 *   - 200 { ok } unbinds + audits.
 *   - 400 when connectorName is missing.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockBind = jest.fn();
const mockUnbind = jest.fn();
const mockListNames = jest.fn();
jest.mock("@/lib/agents/connections/store", () => ({
  bindAgentConnection: (...a: any[]) => mockBind(...a),
  unbindAgentConnection: (...a: any[]) => mockUnbind(...a),
  listAgentConnectionNames: (...a: any[]) => mockListNames(...a),
}));

const mockListCreds = jest.fn();
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  listConnectorCredentials: (...a: any[]) => mockListCreds(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "test" }),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const CREDS = [
  { connectorName: "salesforce", baseUrl: "https://sf.example", authType: "oauth_password", isActive: true },
  { connectorName: "jira", baseUrl: "https://jira.example", authType: "static_bearer", isActive: true },
  { connectorName: "old-disabled", baseUrl: "https://x.example", authType: "static_bearer", isActive: false },
];

function mkReq(body?: unknown): any {
  return {
    url: "http://x/api/admin/agents/a_1/connections",
    headers: new Headers(),
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
  mockListCreds.mockResolvedValue(CREDS);
  mockListNames.mockResolvedValue(["salesforce"]);
  mockBind.mockResolvedValue(true);
  mockUnbind.mockResolvedValue(true);
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/agents/[id]/connections", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(403);
    expect(mockListNames).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    const { GET } = await import("@/app/api/admin/agents/[id]/connections/route");
    await GET(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("200 returns bound (joined) + available (active, unbound)", async () => {
    const { GET } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bound: Array<{ connectorName: string; baseUrl: string; authType: string }>;
      available: Array<{ connectorName: string }>;
    };
    // salesforce is bound -> appears in bound with its details, not available.
    expect(body.bound).toEqual([
      { connectorName: "salesforce", baseUrl: "https://sf.example", authType: "oauth_password" },
    ]);
    // jira is active + unbound -> available. old-disabled is inactive -> dropped.
    expect(body.available.map((c) => c.connectorName)).toEqual(["jira"]);
    expect(mockListNames).toHaveBeenCalledWith("default", "a_1");
  });
});

describe("POST /api/admin/agents/[id]/connections", () => {
  it("400 when connectorName is missing", async () => {
    const { POST } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await POST(mkReq({}), ctx("a_1"));
    expect(res.status).toBe(400);
    expect(mockBind).not.toHaveBeenCalled();
  });

  it("200 binds, returns the refreshed bound list, and audits", async () => {
    // After binding, the agent now has both salesforce + jira bound.
    mockListNames.mockResolvedValue(["salesforce", "jira"]);
    const { POST } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await POST(mkReq({ connectorName: "jira" }), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      bound: Array<{ connectorName: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.bound.map((c) => c.connectorName).sort()).toEqual(["jira", "salesforce"]);

    expect(mockBind).toHaveBeenCalledWith({
      workspaceId: "default",
      agentId: "a_1",
      connectorName: "jira",
      createdBy: "u_cto",
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("agent.connection_bound");
    expect(auditArg.resourceType).toBe("agent_connection");
    expect(auditArg.resourceId).toBe("a_1");
  });

  it("does not audit when the bind was a no-op (already bound)", async () => {
    mockBind.mockResolvedValue(false);
    const { POST } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await POST(mkReq({ connectorName: "salesforce" }), ctx("a_1"));
    expect(res.status).toBe(200);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("still returns 200 when the audit write fails (best-effort)", async () => {
    mockRecordAudit.mockRejectedValue(new Error("audit down"));
    const { POST } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await POST(mkReq({ connectorName: "jira" }), ctx("a_1"));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/agents/[id]/connections", () => {
  it("400 when connectorName is missing", async () => {
    const { DELETE } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await DELETE(mkReq({}), ctx("a_1"));
    expect(res.status).toBe(400);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  it("200 unbinds + audits", async () => {
    const { DELETE } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await DELETE(mkReq({ connectorName: "salesforce" }), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockUnbind).toHaveBeenCalledWith("default", "a_1", "salesforce", "u_cto");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("agent.connection_unbound");
    expect(auditArg.resourceType).toBe("agent_connection");
  });

  it("does not audit when nothing was removed", async () => {
    mockUnbind.mockResolvedValue(false);
    const { DELETE } = await import("@/app/api/admin/agents/[id]/connections/route");
    const res = await DELETE(mkReq({ connectorName: "salesforce" }), ctx("a_1"));
    expect(res.status).toBe(200);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
