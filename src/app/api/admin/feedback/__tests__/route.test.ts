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

  it("200 returns ORG-WIDE feedback (every user, any workspace), forwarding has_screenshot", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValue({
      rows: [
        // Two DIFFERENT workspaces — a reader sees both.
        { id: "f1", workspace_id: "ws_a", user_id: "u1", message: "hi", created_at: "t", has_screenshot: true },
        { id: "f2", workspace_id: "ws_ceo", user_id: "ceo", message: "calendar bug", created_at: "t", has_screenshot: false },
      ],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=all&limit=50"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scope: string;
      feedback: Array<{ id: string; workspace_id: string; has_screenshot: boolean }>;
    };
    expect(body.scope).toBe("org");
    expect(body.feedback).toHaveLength(2);
    // Feedback from a different workspace than the caller is included.
    expect(body.feedback.map((f) => f.workspace_id)).toEqual(["ws_a", "ws_ceo"]);
    expect(body.feedback[0].has_screenshot).toBe(true);
    expect(body.feedback[1].has_screenshot).toBe(false);
    // Single query, NOT workspace-filtered (no workspace-id param passed).
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).not.toMatch(/workspace_id\s*=\s*ANY/);
    expect(sql).not.toMatch(/WHERE workspace_id =/);
  });

  it("queries the screenshot table via an EXISTS clause for has_screenshot", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/feedback/route");
    await GET(mkReq("?status=all"));
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toContain("instinct_feedback_screenshot");
    expect(sql).toContain("AS has_screenshot");
    // Org-wide read: no workspace predicate.
    expect(sql).not.toMatch(/workspace_id\s*=/);
  });

  it("collapses duplicate submissions: one row per (workspace, user, lower(trimmed message))", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/feedback/route");
    await GET(mkReq("?status=all"));
    const sql = String(mockSafeQuery.mock.calls[0][0]);
    // The collapse groups case- and whitespace-insensitively so "Hi" and " hi "
    // land in the same card.
    expect(sql).toContain(
      "DISTINCT ON (workspace_id, user_id, lower(btrim(message)))",
    );
    // It keeps the earliest occurrence so the original timestamp shows, and
    // prefers a resolved row so a resolution is never hidden.
    expect(sql).toContain("(resolved_at IS NOT NULL) DESC");
    expect(sql).toContain("created_at ASC");
    // It surfaces the repeat count + the latest occurrence for the UI.
    expect(sql).toContain("AS times_filed");
    expect(sql).toContain("AS last_filed_at");
    // ...and the page still shows newest-first by the original date.
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  it("returns times_filed and last_filed_at on each collapsed card", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    /* The DB does the collapse; the route passes the shaped rows straight
       through. We assert the route faithfully forwards the dedup metadata so
       the UI can render "filed 3 times, first on <date>". */
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "f1",
          workspace_id: "default",
          user_id: "u1",
          user_email: "a@x.com",
          user_role: "member",
          message: "the calendar is broken",
          surface: "/assistant",
          user_agent: null,
          workflow_id: null,
          created_at: "2026-05-01T10:00:00.000Z",
          resolved_at: null,
          resolved_by: null,
          resolution_note: null,
          times_filed: 3,
          last_filed_at: "2026-05-03T18:00:00.000Z",
        },
      ],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=all"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feedback: Array<{
        times_filed: number;
        created_at: string;
        last_filed_at: string;
      }>;
    };
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].times_filed).toBe(3);
    // created_at is the EARLIEST (original) date, last_filed_at the most recent.
    expect(body.feedback[0].created_at).toBe("2026-05-01T10:00:00.000Z");
    expect(body.feedback[0].last_filed_at).toBe("2026-05-03T18:00:00.000Z");
  });

  it("does not filter by the caller's workspace at all (a reader sees every user's note)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: { ...CTO, workspaceId: "ws_cto" } });
    mockSafeQuery.mockResolvedValue({
      // Feedback from a workspace the caller is NOT in must still come back.
      rows: [{ id: "fc", workspace_id: "ws_ceo", user_id: "ceo", message: "Calendar bug", created_at: "t", has_screenshot: false }],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=open"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feedback: Array<{ workspace_id: string }> };
    expect(body.feedback.map((f) => f.workspace_id)).toContain("ws_ceo");
    // No workspace param and no workspace predicate — capability is the gate.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    expect(mockSafeQuery.mock.calls[0][1]).not.toContain("ws_cto");
    expect(String(mockSafeQuery.mock.calls[0][0])).not.toMatch(/workspace_id\s*=/);
  });

  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});
