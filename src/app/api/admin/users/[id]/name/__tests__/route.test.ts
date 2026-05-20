/**
 * Contract tests for PATCH /api/admin/users/[id]/name.
 *
 * Locked behaviors:
 *   - 403 without settings.manage_team
 *   - 400 missing / empty / over-length name
 *   - 404 unknown user_id
 *   - 200 happy path: UPDATE fires, audit + analytics recorded
 *   - 200 shadow mode (no DATABASE_URL): echoes back, no SQL
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: (...a: any[]) => mockQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const mockRecordAudit = jest.fn();
const mockExtractMeta: jest.Mock = jest.fn(() => ({
  ipAddress: "1.1.1.1",
  userAgent: "test",
  requestId: "r1",
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: (...a: any[]) => mockExtractMeta(...a),
}));

function mkReq(body: unknown): any {
  return { json: async () => body, headers: new Headers() };
}

function mkParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const CTO = { id: "u_cto", email: "homyk@thewolfpack.agency", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
  process.env.DATABASE_URL = "postgresql://test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("PATCH /api/admin/users/[id]/name", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "Nick" }), mkParams("tm_x"));
    expect(res.status).toBe(403);
  });

  it("400 missing name", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({}), mkParams("tm_x"));
    expect(res.status).toBe(400);
  });

  it("400 empty (whitespace-only) name", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "   " }), mkParams("tm_x"));
    expect(res.status).toBe(400);
  });

  it("400 over-length name (>120)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "A".repeat(121) }), mkParams("tm_x"));
    expect(res.status).toBe(400);
  });

  it("404 unknown user_id", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "Nick" }), mkParams("tm_unknown"));
    expect(res.status).toBe(404);
  });

  it("200 happy path: UPDATE fires, audit + analytics recorded", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ name: "TEST" }], fromCache: false });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "  Nick Homyk  " }), mkParams("tm_f7e52863-a45"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, from_name: "TEST", to_name: "Nick Homyk" });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE instinct_team_members SET name/),
      ["tm_f7e52863-a45", "Nick Homyk"],
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.team_member_renamed",
      CTO.id,
      CTO.role,
      expect.objectContaining({ to_name: "Nick Homyk", from_name: "TEST" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "team.member.renamed" }),
    );
  });

  it("200 shadow mode (no DATABASE_URL): echoes back, no SQL", async () => {
    delete process.env.DATABASE_URL;
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { PATCH } = await import("@/app/api/admin/users/[id]/name/route");
    const res = await PATCH(mkReq({ name: "Nick" }), mkParams("tm_x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, name: "Nick", shadow: true });
    expect(mockSafeQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
