/**
 * Contract tests for GET /api/admin/ogiam/decisions.
 *
 * Asserts the capability gate (401/403), the 200 response shape
 * { workspace_id, summary, decisions }, that the would_block filter is
 * forwarded into listDecisions, and the 503-on-no-database degrade path.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockList = jest.fn();
const mockSummarize = jest.fn();
jest.mock("@/lib/ogiam/queries", () => ({
  listDecisions: (...a: any[]) => mockList(...a),
  summarizeDecisions: (...a: any[]) => mockSummarize(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(qs = ""): any {
  return { url: `http://x/api/admin/ogiam/decisions${qs}`, headers: new Headers() };
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  mockSummarize.mockResolvedValue({ total: 0, would_block: 0, by_tier: {}, by_outcome: {} });
  mockList.mockResolvedValue([]);
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("GET /api/admin/ogiam/decisions", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("gates on settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    await GET(mkReq());
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
  });

  it("200 returns { workspace_id, summary, decisions } scoped to the caller's workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSummarize.mockResolvedValue({
      total: 3,
      would_block: 1,
      by_tier: { low: 2, high: 1 },
      by_outcome: { allow: 2, deny: 1 },
    });
    mockList.mockResolvedValue([
      {
        id: "d1",
        created_at: "t",
        principal_agent: "assistant",
        on_behalf_user_id: "u1",
        on_behalf_role: "cto",
        tool: "mail.send",
        capability: "mail.send",
        is_mutation: true,
        surface: "/assistant",
        risk_tier: "high",
        intended_outcome: "deny",
        effective_outcome: "allow",
        enforced: false,
        would_block: true,
        rule_id: "R-1",
        reason: "x",
        policy_version: "v0",
      },
    ]);

    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    const res = await GET(mkReq("?limit=200"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace_id: string;
      summary: { total: number; would_block: number };
      decisions: Array<{ id: string }>;
    };
    expect(body.workspace_id).toBe("default");
    expect(body.summary.total).toBe(3);
    expect(body.summary.would_block).toBe(1);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].id).toBe("d1");
    // Both queries ran scoped to the workspace.
    expect(mockSummarize).toHaveBeenCalledWith("default");
    expect(mockList.mock.calls[0][0]).toBe("default");
  });

  it("forwards the would_block filter and parsed limit to listDecisions", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    await GET(mkReq("?limit=50&would_block=1"));
    expect(mockList).toHaveBeenCalledWith("default", { limit: 50, wouldBlockOnly: true });
  });

  it("does not set wouldBlockOnly when ?would_block is absent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    await GET(mkReq());
    expect(mockList).toHaveBeenCalledWith("default", {
      limit: undefined,
      wouldBlockOnly: false,
      agentId: undefined,
    });
  });

  it("forwards ?agent as the agentId filter to listDecisions", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    await GET(mkReq("?agent=a_42"));
    expect(mockList).toHaveBeenCalledWith("default", {
      limit: undefined,
      wouldBlockOnly: false,
      agentId: "a_42",
    });
  });

  it("treats a blank ?agent as no filter (agentId undefined)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    await GET(mkReq("?agent=%20%20"));
    expect(mockList).toHaveBeenCalledWith("default", {
      limit: undefined,
      wouldBlockOnly: false,
      agentId: undefined,
    });
  });

  it("503 when no DATABASE_URL is configured", async () => {
    delete process.env.DATABASE_URL;
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/ogiam/decisions/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(503);
  });
});
