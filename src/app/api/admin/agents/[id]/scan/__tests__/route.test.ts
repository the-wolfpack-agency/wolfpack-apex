/**
 * Contract tests for /api/admin/agents/[id]/scan.
 *
 * GET (the human view of an agent's latest self-onboarding scan):
 *   - unauthenticated / unauthorized -> 401 / 403 (gated on settings.manage_team).
 *   - no stored scan -> 404 no_scan (explicit absence, never a blank 200).
 *   - happy path -> 200 { scan } scoped to the caller's workspace.
 *
 * POST (the admin trigger that makes the agent run the SAME self-onboarding scan):
 *   - unauthorized -> 401 (returns auth.response).
 *   - missing id -> 400; agent missing in workspace -> 404 not_found.
 *   - revoked / paused agent -> 409 agent_not_active (saveScan never runs).
 *   - happy path -> 200 + saveScan(model) + recordAudit("agent.scan_completed")
 *     + trackEvent("agent.scan_completed", source "admin").
 *   - audit failure is best-effort: scan still returns 200.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockGetLatestScan = jest.fn();
const mockSaveScan = jest.fn();
jest.mock("@/lib/agents/scan-store", () => ({
  getLatestScan: (...a: any[]) => mockGetLatestScan(...a),
  saveScan: (...a: any[]) => mockSaveScan(...a),
}));

const mockGetAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: any[]) => mockGetAgent(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "test" }),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const AGENT = { id: "a_1", workspaceId: "default", name: "Scout", role: "member", state: "active" };

function mkReq(): any {
  return { url: "http://x/api/admin/agents/a_1/scan", headers: new Headers() };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

const SCAN = {
  id: "scan_1",
  agentId: "a_1",
  workspaceId: "default",
  scanVersion: "agent-scan-2026-06-24.1",
  toolCount: 12,
  allowedToolCount: 4,
  capabilityCount: 1,
  createdAt: "2026-06-19T00:00:00.000Z",
  model: { scanVersion: "agent-scan-2026-06-24.1", tools: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLatestScan.mockResolvedValue(SCAN);
  mockGetAgent.mockResolvedValue(AGENT);
  mockSaveScan.mockResolvedValue({ id: "scan_new" });
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/agents/[id]/scan", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetLatestScan).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(403);
    expect(mockGetLatestScan).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/scan/route");
    await GET(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("404 no_scan when the agent has no stored scan", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetLatestScan.mockResolvedValue(null);
    const { GET } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_scan");
  });

  it("200 returns { scan } scoped to the caller's workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { id: string; agentId: string } };
    expect(body.scan.id).toBe("scan_1");
    expect(body.scan.agentId).toBe("a_1");
    // The latest scan is read for the requested id scoped to the caller's workspace.
    expect(mockGetLatestScan).toHaveBeenCalledWith("a_1", "default");
  });
});

describe("POST /api/admin/agents/[id]/scan", () => {
  it("401 when capability is denied (returns auth.response)", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    await POST(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("400 when the id is missing", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx(""));
    expect(res.status).toBe(400);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("404 not_found when the agent does not exist in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("409 agent_not_active when the agent is paused (saveScan not called)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue({ ...AGENT, state: "paused" });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_active");
    expect(mockSaveScan).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("409 agent_not_active when the agent is revoked (saveScan not called)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue({ ...AGENT, state: "revoked" });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("agent_not_active");
    expect(mockSaveScan).not.toHaveBeenCalled();
  });

  it("200 runs the scan, persists it, audits, and tracks with source admin", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      summary: { toolCount: number };
      scan_version: string;
      tool_count: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.scan_version).toBe("string");
    expect(body.summary.toolCount).toBe(body.tool_count);

    // saveScan got the real model the scan produced for this agent's role.
    expect(mockSaveScan).toHaveBeenCalledTimes(1);
    const savedModel = mockSaveScan.mock.calls[0][0];
    expect(savedModel.agentId).toBe("a_1");
    expect(savedModel.role).toBe("member");
    expect(savedModel.workspaceId).toBe("default");
    expect(savedModel.scanVersion).toBe(body.scan_version);
    expect(savedModel.tools.length).toBe(body.tool_count);

    // The mutation is hash-chained.
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("agent.scan_completed");
    expect(auditArg.resourceType).toBe("agent");
    expect(auditArg.resourceId).toBe("a_1");
    expect(auditArg.actor).toEqual({ user_id: "u_cto", role: "cto" });
    expect(auditArg.afterState).toEqual({
      tool_count: savedModel.tools.length,
      scan_version: savedModel.scanVersion,
    });

    // Analytics fires with the admin source + the triggering user.
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, userId, userRole, meta] = mockTrackEvent.mock.calls[0];
    expect(event).toBe("agent.scan_completed");
    expect(userId).toBe("a_1");
    expect(userRole).toBe("agent");
    expect(meta.source).toBe("admin");
    expect(meta.triggered_by).toBe("u_cto");
    expect(meta.workspace_id).toBe("default");
    expect(meta.tool_count).toBe(savedModel.tools.length);
  });

  it("still returns 200 when the audit write fails (best-effort)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockRecordAudit.mockRejectedValue(new Error("audit down"));
    const { POST } = await import("@/app/api/admin/agents/[id]/scan/route");
    const res = await POST(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    expect(mockSaveScan).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });
});
