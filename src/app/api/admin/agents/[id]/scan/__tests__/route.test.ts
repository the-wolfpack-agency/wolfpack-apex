/**
 * Contract tests for GET /api/admin/agents/[id]/scan: the human view of an
 * agent's latest self-onboarding scan.
 *
 *   - unauthenticated / unauthorized -> 401 / 403 (gated on settings.manage_team).
 *   - no stored scan -> 404 no_scan (explicit absence, never a blank 200).
 *   - happy path -> 200 { scan } scoped to the caller's workspace.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockGetLatestScan = jest.fn();
jest.mock("@/lib/agents/scan-store", () => ({
  getLatestScan: (...a: any[]) => mockGetLatestScan(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

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
