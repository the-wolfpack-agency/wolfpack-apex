/**
 * Contract tests for POST /api/admin/users/[id]/role.
 *
 * Locked behaviors:
 *   - 403 without admin.roles.assign
 *   - 400 invalid role
 *   - 404 unknown user_id
 *   - 200 happy path: UPDATE fires, analytics + AUDIT recorded with the right
 *     action + afterState (security-relevant role change → hash-chained log)
 *   - 200 shadow mode (no DATABASE_URL): echoes back, no SQL, no audit write
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

const CTO = { id: "u_cto", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
  process.env.DATABASE_URL = "postgresql://test";
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("POST /api/admin/users/[id]/role", () => {
  it("403 without admin.roles.assign", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/users/[id]/role/route");
    const res = await POST(mkReq({ role: "ops" }), mkParams("tm_x"));
    expect(res.status).toBe(403);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("400 invalid role", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/users/[id]/role/route");
    const res = await POST(mkReq({ role: "not_a_role" }), mkParams("tm_x"));
    expect(res.status).toBe(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("404 unknown user_id (no audit)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { POST } = await import("@/app/api/admin/users/[id]/role/route");
    const res = await POST(mkReq({ role: "ops" }), mkParams("tm_unknown"));
    expect(res.status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("200 happy path: UPDATE fires, analytics + AUDIT recorded with action + afterState", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ role: "dev" }], fromCache: false });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { POST } = await import("@/app/api/admin/users/[id]/role/route");
    const res = await POST(mkReq({ role: "ops" }), mkParams("tm_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, from_role: "dev", to_role: "ops" });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.role_changed",
      CTO.id,
      CTO.role,
      expect.objectContaining({ from_role: "dev", to_role: "ops" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { user_id: CTO.id, role: CTO.role },
        action: "admin.user.role_changed",
        resourceType: "team_member",
        resourceId: "tm_1",
        beforeState: { role: "dev" },
        afterState: { role: "ops" },
        ipAddress: "1.1.1.1",
        requestId: "r1",
      }),
    );
  });

  it("200 shadow mode (no DATABASE_URL): echoes back, no SQL, no real audit write", async () => {
    delete process.env.DATABASE_URL;
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/users/[id]/role/route");
    const res = await POST(mkReq({ role: "ops" }), mkParams("tm_x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "ops", shadow: true });
    expect(mockQuery).not.toHaveBeenCalled();
    // Shadow path returns before reaching recordAudit.
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
