/**
 * Contract tests for GET /api/admin/feedback, including the duplicate collapse
 * that keeps the inbox readable when the feedback widget double-submits.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(qs = ""): any {
  return { url: `http://x/api/admin/feedback${qs}`, headers: new Headers() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("GET /api/admin/feedback", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("200 returns workspace-scoped feedback", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValue({
      rows: [{ id: "f1", workspace_id: "default", user_id: "u1", message: "hi", created_at: "t" }],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=all&limit=50"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_id: string; feedback: unknown[] };
    expect(body.workspace_id).toBe("default");
    expect(body.feedback).toHaveLength(1);
    // workspace scoping is parameterized (first arg is workspace_id)
    expect(mockSafeQuery.mock.calls[0][1][0]).toBe("default");
  });

  it("collapses duplicate submissions: one row per (workspace, user, message)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/feedback/route");
    await GET(mkReq("?status=all"));
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    // The collapse: distinct per workspace + user + trimmed message...
    expect(sql).toContain("DISTINCT ON (workspace_id, user_id, btrim(message))");
    // ...keeping the earliest occurrence so the original timestamp/resolution stays.
    expect(sql).toContain("btrim(message), created_at ASC");
    // ...and the page still shows newest-first.
    expect(sql).toContain("ORDER BY created_at DESC");
  });
});
