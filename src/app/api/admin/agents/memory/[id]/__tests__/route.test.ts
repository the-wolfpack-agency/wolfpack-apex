/**
 * Contract tests for PATCH /api/admin/agents/memory/[id].
 *
 * The human promote/reject override on a learned procedure. Covers the gate
 * (401), the action validation (400), the not-found path (404), and the two
 * success paths (200), each asserting setMemoryStatus is called with the
 * mapped status + actor and that recordAudit logs "agent.procedure_override"
 * so the governance decision is hash-chained.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSetStatus = jest.fn();
jest.mock("@/lib/agents/memory/store", () => ({
  setMemoryStatus: (...a: any[]) => mockSetStatus(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest" }),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  writeQuery: jest.fn(),
  safeQuery: jest.fn(),
  pool: { connect: jest.fn() },
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(body: unknown): any {
  return {
    url: "http://x/api/admin/agents/memory/m1",
    headers: new Headers(),
    json: async () => body,
  };
}

const params = Promise.resolve({ id: "m1" });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
  mockSetStatus.mockResolvedValue({
    id: "m1",
    workspaceId: "default",
    status: "promoted",
  });
  mockRecordAudit.mockResolvedValue({ id: "a1", seq: 1, entryHash: "h" });
});

describe("PATCH /api/admin/agents/memory/[id]", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq({ action: "promote" }), { params });
    expect(res.status).toBe(401);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("400 on a bad action", async () => {
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq({ action: "frobnicate" }), { params });
    expect(res.status).toBe(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("400 when the body is missing/unparseable", async () => {
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq(null), { params });
    expect(res.status).toBe(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("404 when setMemoryStatus returns null (no such entry in workspace)", async () => {
    mockSetStatus.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq({ action: "reject" }), { params });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    // a miss is not a governance event, so nothing is audited
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("200 promote: maps to 'promoted', passes the actor, audits the override", async () => {
    mockSetStatus.mockResolvedValue({
      id: "m1",
      workspaceId: "default",
      status: "promoted",
    });
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq({ action: "promote" }), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { status: string } };
    expect(body.memory.status).toBe("promoted");

    expect(mockSetStatus).toHaveBeenCalledWith(
      "m1",
      "default",
      "promoted",
      { userId: "u_cto", role: "cto" },
      undefined,
    );

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audited = mockRecordAudit.mock.calls[0][0];
    expect(audited.action).toBe("agent.procedure_override");
    expect(audited.resourceType).toBe("agent_memory");
    expect(audited.resourceId).toBe("m1");
    expect(audited.afterState).toEqual({ status: "promoted", reason: null });
    expect(audited.actor).toEqual({ user_id: "u_cto", role: "cto" });
  });

  it("200 reject: maps to 'rejected', forwards the reason, audits the override", async () => {
    mockSetStatus.mockResolvedValue({
      id: "m1",
      workspaceId: "default",
      status: "rejected",
    });
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(
      mkReq({ action: "reject", reason: "leaks a secret" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { status: string } };
    expect(body.memory.status).toBe("rejected");

    expect(mockSetStatus).toHaveBeenCalledWith(
      "m1",
      "default",
      "rejected",
      { userId: "u_cto", role: "cto" },
      "leaks a secret",
    );

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audited = mockRecordAudit.mock.calls[0][0];
    expect(audited.action).toBe("agent.procedure_override");
    expect(audited.afterState).toEqual({
      status: "rejected",
      reason: "leaks a secret",
    });
  });

  it("still returns 200 when the audit write throws (best-effort logging)", async () => {
    mockRecordAudit.mockRejectedValue(new Error("audit down"));
    const { PATCH } = await import("@/app/api/admin/agents/memory/[id]/route");
    const res = await PATCH(mkReq({ action: "promote" }), { params });
    expect(res.status).toBe(200);
  });
});
