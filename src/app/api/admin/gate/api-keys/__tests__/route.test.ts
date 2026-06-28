/**
 * Contract tests for /api/admin/gate/api-keys (POST mint + GET list) and the
 * [id] DELETE revoke subroute.
 *
 * Asserts the capability gate (401/403), the 200 mint returns the plaintext key
 * ONCE, the 200 list returns masked rows that never leak the hash, revoke works
 * and is audit-logged, and bad input is 400. The api-keys lib + audit log are
 * mocked; the route logic (validation, workspace scoping, audit) is the unit
 * under test.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockCreate = jest.fn();
const mockList = jest.fn();
const mockRevoke = jest.fn();
jest.mock("@/lib/ogiam/api-keys", () => ({
  createApiKey: (...a: any[]) => mockCreate(...a),
  listApiKeys: (...a: any[]) => mockList(...a),
  revokeApiKey: (...a: any[]) => mockRevoke(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({
    ipAddress: "1.2.3.4",
    userAgent: "jest",
    requestId: "req_1",
  }),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "ws_a" };

function mkReq(body?: unknown): any {
  return {
    url: "http://x/api/admin/gate/api-keys",
    headers: new Headers(),
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/gate/api-keys (mint)", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq({ agent: "a", capabilities: [] }));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq({ agent: "a", capabilities: [] }));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreate.mockResolvedValue({ id: "gak_1", plaintextKey: "ogk_x", prefix: "ogk_xxxxxx", last4: "abcd" });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    await POST(mkReq({ agent: "acme.qa-bot", capabilities: ["mail.read"] }));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("200 mint returns the plaintext key ONCE + masked metadata", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreate.mockResolvedValue({
      id: "gak_1",
      plaintextKey: "ogk_SECRET_PLAINTEXT_VALUE",
      prefix: "ogk_SECRET",
      last4: "ALUE",
    });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq({ agent: "acme.qa-bot", capabilities: ["mail.read"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("ogk_SECRET_PLAINTEXT_VALUE");
    expect(body.id).toBe("gak_1");
    expect(body.agent).toBe("acme.qa-bot");
    expect(body.capabilities).toEqual(["mail.read"]);
    expect(body.message).toMatch(/shown once/i);
    // workspaceId + createdBy come from the session, not the body.
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "ws_a",
      agent: "acme.qa-bot",
      capabilities: ["mail.read"],
      createdBy: "u_cto",
    });
  });

  it("audits the mint without logging the plaintext key", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreate.mockResolvedValue({
      id: "gak_1",
      plaintextKey: "ogk_SECRET_PLAINTEXT_VALUE",
      prefix: "ogk_SECRET",
      last4: "ALUE",
    });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    await POST(mkReq({ agent: "acme.qa-bot", capabilities: ["mail.read"] }));
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const arg = mockRecordAudit.mock.calls[0][0];
    expect(arg.action).toBe("gate.api_key.minted");
    expect(arg.resourceId).toBe("gak_1");
    expect(JSON.stringify(arg)).not.toContain("ogk_SECRET_PLAINTEXT_VALUE");
  });

  it("400 when agent missing", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq({ capabilities: [] }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("400 when capabilities is not an array of strings", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq({ agent: "a", capabilities: [1, 2] }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await POST(mkReq()); // json() throws
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/gate/api-keys (list)", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("200 returns masked rows scoped to the caller's workspace, never the hash", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockList.mockResolvedValue([
      {
        id: "gak_1",
        workspaceId: "ws_a",
        agent: "acme.qa-bot",
        prefix: "ogk_abc123",
        last4: "wxyz",
        capabilities: ["mail.read"],
        createdBy: "u_cto",
        createdAt: "t",
        revokedAt: null,
        lastUsedAt: null,
        revoked: false,
      },
    ]);
    const { GET } = await import("@/app/api/admin/gate/api-keys/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace_id).toBe("ws_a");
    expect(body.keys).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/key_hash|plaintext/i);
    expect(mockList).toHaveBeenCalledWith("ws_a");
  });
});

describe("DELETE /api/admin/gate/api-keys/[id] (revoke)", () => {
  function mkDelReq(): any {
    return { url: "http://x/api/admin/gate/api-keys/gak_1", headers: new Headers() };
  }

  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { DELETE } = await import("@/app/api/admin/gate/api-keys/[id]/route");
    const res = await DELETE(mkDelReq(), { params: Promise.resolve({ id: "gak_1" }) });
    expect(res.status).toBe(401);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("revokes (workspace-scoped) and audits", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockRevoke.mockResolvedValue(true);
    const { DELETE } = await import("@/app/api/admin/gate/api-keys/[id]/route");
    const res = await DELETE(mkDelReq(), { params: Promise.resolve({ id: "gak_1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(true);
    expect(mockRevoke).toHaveBeenCalledWith("gak_1", "ws_a");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("gate.api_key.revoked");
  });

  it("returns revoked:false when nothing was revoked (wrong workspace / unknown id)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockRevoke.mockResolvedValue(false);
    const { DELETE } = await import("@/app/api/admin/gate/api-keys/[id]/route");
    const res = await DELETE(mkDelReq(), { params: Promise.resolve({ id: "gak_x" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(false);
  });
});
