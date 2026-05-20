/**
 * Contract tests for GET /api/admin/time-summary.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSummarize = jest.fn();
jest.mock("@/lib/time-entries", () => ({
  summarizeTimeEntries: (...a: any[]) => mockSummarize(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(url = "https://app/api/admin/time-summary"): any {
  return { url, headers: new Headers() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/admin/time-summary", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/time-summary/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
  });

  it("rolls up by user + by job_code, computes summary totals", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSummarize.mockResolvedValueOnce([
      { user_id: "u1", user_email: "a@x.com", user_role: "ops", job_code: "WOLFPACK-AUTO", total_hours: 5, entry_count: 3 },
      { user_id: "u1", user_email: "a@x.com", user_role: "ops", job_code: "CLIENT-ACME",    total_hours: 2, entry_count: 1 },
      { user_id: "u2", user_email: "b@x.com", user_role: "dev", job_code: "WOLFPACK-AUTO", total_hours: 4, entry_count: 2 },
    ]);
    const { GET } = await import("@/app/api/admin/time-summary/route");
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total_hours).toBe(11);
    expect(body.summary.entry_count).toBe(6);
    expect(body.summary.contributor_count).toBe(2);
    expect(body.summary.job_code_count).toBe(2);
    /* per_user sorted DESC by total_hours */
    expect(body.per_user[0]).toEqual(expect.objectContaining({ user_id: "u1", total_hours: 7, entry_count: 4 }));
    expect(body.per_user[1]).toEqual(expect.objectContaining({ user_id: "u2", total_hours: 4 }));
    /* per_job sorted DESC, contributor_count counts distinct users */
    expect(body.per_job[0]).toEqual(expect.objectContaining({ job_code: "WOLFPACK-AUTO", total_hours: 9, contributor_count: 2 }));
    expect(body.per_job[1]).toEqual(expect.objectContaining({ job_code: "CLIENT-ACME", contributor_count: 1 }));
  });

  it("respects ?since= query param", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSummarize.mockResolvedValueOnce([]);
    const { GET } = await import("@/app/api/admin/time-summary/route");
    await GET(mkReq("https://app/api/admin/time-summary?since=2026-01-01"));
    expect(mockSummarize).toHaveBeenCalledWith(expect.objectContaining({ since: "2026-01-01" }));
  });
});
