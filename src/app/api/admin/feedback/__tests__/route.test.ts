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

  it("200 returns workspace-scoped feedback, forwarding has_screenshot per row", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "f1",
          workspace_id: "default",
          user_id: "u1",
          message: "hi",
          created_at: "t",
          has_screenshot: true,
        },
        {
          id: "f2",
          workspace_id: "default",
          user_id: "u2",
          message: "no pic",
          created_at: "t",
          has_screenshot: false,
        },
      ],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=all&limit=50"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace_ids: string[];
      feedback: Array<{ id: string; has_screenshot: boolean }>;
    };
    expect(body.workspace_ids).toEqual(["default"]);
    expect(body.feedback).toHaveLength(2);
    // The route forwards the per-row screenshot flag the SQL EXISTS produced.
    expect(body.feedback[0].has_screenshot).toBe(true);
    expect(body.feedback[1].has_screenshot).toBe(false);
    // Two queries now: [0] resolves the viewer's workspaces, [1] is the feedback
    // read, parameterized by the workspace-id ARRAY.
    expect(mockSafeQuery.mock.calls[1][1][0]).toEqual(["default"]);
  });

  it("queries the screenshot table via an EXISTS clause for has_screenshot", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/feedback/route");
    await GET(mkReq("?status=all"));
    const sql = String(mockSafeQuery.mock.calls[1][0]);
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toContain("instinct_feedback_screenshot");
    expect(sql).toContain("AS has_screenshot");
    // Scope is the viewer's workspace ARRAY, not a single id.
    expect(sql).toContain("workspace_id = ANY($1)");
  });

  it("collapses duplicate submissions: one row per (workspace, user, lower(trimmed message))", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/admin/feedback/route");
    await GET(mkReq("?status=all"));
    const sql = String(mockSafeQuery.mock.calls[1][0]);
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

  it("shows feedback from EVERY workspace the viewer reads (the CEO-feedback fix)", async () => {
    // The viewer is an active member/reader of two workspaces. The bug: the inbox
    // only queried the session's single workspace, hiding CEO feedback filed in
    // the other one — even though the viewer got the bell notification for it.
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery
      // [0] resolve the viewer's workspaces (id/email membership)
      .mockResolvedValueOnce({
        rows: [{ workspace_id: "ws_cto" }, { workspace_id: "ws_ceo" }],
        fromCache: false,
      })
      // [1] the feedback read, now scoped to that array
      .mockResolvedValueOnce({
        rows: [{ id: "fc", workspace_id: "ws_ceo", user_id: "ceo", message: "Calendar bug", created_at: "t", has_screenshot: false }],
        fromCache: false,
      });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq("?status=open"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_ids: string[]; feedback: Array<{ workspace_id: string }> };
    // Scope includes both member workspaces AND the session workspace, deduped.
    expect(new Set(body.workspace_ids)).toEqual(new Set(["ws_cto", "ws_ceo", "default"]));
    // The CEO's note (other workspace) is now returned.
    expect(body.feedback.map((f) => f.workspace_id)).toContain("ws_ceo");
    // The feedback query is scoped to exactly that authorized array (tenant-safe).
    expect(String(mockSafeQuery.mock.calls[1][0])).toContain("workspace_id = ANY($1)");
    expect(new Set(mockSafeQuery.mock.calls[1][1][0] as string[])).toEqual(
      new Set(["ws_cto", "ws_ceo", "default"]),
    );
    // The membership lookup is gated to active rows keyed by the viewer (id/email).
    expect(String(mockSafeQuery.mock.calls[0][0])).toMatch(/instinct_team_members[\s\S]*is_active = true/);
  });

  it("falls back to the session workspace when the viewer has no membership rows", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    // memberWs empty -> only the session workspace is used (no regression).
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });
    const { GET } = await import("@/app/api/admin/feedback/route");
    const res = await GET(mkReq());
    const body = (await res.json()) as { workspace_ids: string[] };
    expect(body.workspace_ids).toEqual(["default"]);
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
