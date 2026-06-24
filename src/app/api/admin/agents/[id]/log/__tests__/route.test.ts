/**
 * Contract tests for GET /api/admin/agents/[id]/log (the per-agent action trail).
 *
 *   - unauthenticated -> 401 (gated on settings.manage_team).
 *   - unknown agent -> 404 (never leaks another workspace's existence).
 *   - happy path -> 200 { entries } scoped to the workspace, decision + outcome
 *     joined, with the analytics event fired.
 *   - empty state -> 200 { entries: [] }.
 *   - ?limit is forwarded to the query.
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

const mockListTrail = jest.fn();
jest.mock("@/lib/ogiam/queries", () => ({
  listAgentActionTrail: (...a: any[]) => mockListTrail(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(),
  writeQuery: jest.fn(),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const ENTRY = {
  id: "d_1",
  seq: 7,
  created_at: "2026-06-19T02:00:00.000Z",
  tool: "search",
  capability: "*",
  surface: "/agent",
  risk_tier: "low",
  intended_outcome: "allow",
  effective_outcome: "allow",
  would_block: false,
  rule_id: "default.allow",
  reason: "no rule blocked",
  policy_version: "v1",
  on_behalf_user_id: "a_1",
  on_behalf_role: "agent",
  redacted_params: '{"q":"status"}',
  signals: { piiDetected: false },
  params_hash: "abc",
  entry_hash: "def",
  outcome: { ok: true, code: "ok", result_redacted: "all green", duration_ms: 12 },
};

function mkReq(url = "http://x/api/admin/agents/a_1/log"): any {
  return { nextUrl: new URL(url), headers: new Headers() };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: "a_1", workspaceId: "default" });
  mockListTrail.mockResolvedValue([ENTRY]);
});

describe("GET /api/admin/agents/[id]/log", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(401);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockListTrail).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    await GET(mkReq(), ctx("a_1"));
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("404 for an unknown agent (no workspace leak)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockGetAgent.mockResolvedValue(null);
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    const res = await GET(mkReq(), ctx("ghost"));
    expect(res.status).toBe(404);
    expect(mockListTrail).not.toHaveBeenCalled();
  });

  it("200 returns { entries } with the decision + outcome joined", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: typeof ENTRY[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe("d_1");
    expect(body.entries[0].entry_hash).toBe("def");
    expect(body.entries[0].outcome?.result_redacted).toBe("all green");
    expect(mockGetAgent).toHaveBeenCalledWith("a_1", "default");
    expect(mockListTrail).toHaveBeenCalledWith("default", "a_1", undefined);
  });

  it("fires agent.log_viewed with the decision count", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    await GET(mkReq(), ctx("a_1"));
    expect(mockTrack).toHaveBeenCalledWith(
      "agent.log_viewed",
      "u_cto",
      "cto",
      expect.objectContaining({ agent_id: "a_1", decision_count: 1 }),
    );
  });

  it("200 with explicit empty state when there is no trail", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockListTrail.mockResolvedValue([]);
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    const res = await GET(mkReq(), ctx("a_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it("forwards ?limit to the trail query", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/agents/[id]/log/route");
    await GET(mkReq("http://x/api/admin/agents/a_1/log?limit=25"), ctx("a_1"));
    expect(mockListTrail).toHaveBeenCalledWith("default", "a_1", 25);
  });
});
