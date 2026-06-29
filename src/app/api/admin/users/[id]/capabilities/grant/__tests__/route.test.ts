/**
 * Contract tests for POST /api/admin/users/[id]/capabilities/grant.
 *
 * Locked behaviors:
 *   - 403 without admin.roles.assign
 *   - 400 invalid capability / invalid expiresAt
 *   - 404 unknown user (persist fails with DATABASE_URL set)
 *   - 200 happy path: grant applied, analytics + AUDIT recorded with the right
 *     action + afterState (security-relevant capability grant → hash chain)
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockLoad = jest.fn();
const mockSave = jest.fn();
const mockApplyGrant = jest.fn();
const mockEmpty: jest.Mock = jest.fn(() => ({ grants: [], revokes: [] }));
jest.mock("@/lib/auth/capability-overrides", () => ({
  loadUserOverrides: (...a: any[]) => mockLoad(...a),
  saveUserOverrides: (...a: any[]) => mockSave(...a),
  applyGrant: (...a: any[]) => mockApplyGrant(...a),
  emptyOverrides: (...a: any[]) => mockEmpty(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const mockRecordAudit = jest.fn();
const mockExtractMeta: jest.Mock = jest.fn(() => ({
  ipAddress: "2.2.2.2",
  userAgent: "test",
  requestId: "r2",
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
const EXISTING = { grants: [], revokes: [] };
const NEXT = { grants: ["settings.manage_team"], revokes: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
  mockLoad.mockResolvedValue({ overrides: EXISTING });
  mockApplyGrant.mockReturnValue(NEXT);
  mockSave.mockResolvedValue(true);
  process.env.DATABASE_URL = "postgresql://test";
});
afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("POST /api/admin/users/[id]/capabilities/grant", () => {
  it("403 without admin.roles.assign", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/users/[id]/capabilities/grant/route");
    const res = await POST(mkReq({ capability: "settings.manage_team" }), mkParams("tm_x"));
    expect(res.status).toBe(403);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("400 invalid capability", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/users/[id]/capabilities/grant/route");
    const res = await POST(mkReq({ capability: "not.a.cap" }), mkParams("tm_x"));
    expect(res.status).toBe(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("400 invalid expiresAt", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/users/[id]/capabilities/grant/route");
    const res = await POST(
      mkReq({ capability: "settings.manage_team", expiresAt: "not-a-date" }),
      mkParams("tm_x"),
    );
    expect(res.status).toBe(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("404 unknown user (persist fails)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockSave.mockResolvedValue(false);
    const { POST } = await import("@/app/api/admin/users/[id]/capabilities/grant/route");
    const res = await POST(mkReq({ capability: "settings.manage_team" }), mkParams("tm_unknown"));
    expect(res.status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("200 happy path: analytics + AUDIT recorded with action + afterState", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/users/[id]/capabilities/grant/route");
    const res = await POST(mkReq({ capability: "settings.manage_team" }), mkParams("tm_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, overrides: NEXT });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.capability_granted_override",
      CTO.id,
      CTO.role,
      expect.objectContaining({ capability: "settings.manage_team", user_id: "tm_1" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { user_id: CTO.id, role: CTO.role },
        action: "admin.user.capability_granted",
        resourceType: "team_member",
        resourceId: "tm_1",
        beforeState: { overrides: EXISTING },
        afterState: expect.objectContaining({ overrides: NEXT, capability: "settings.manage_team" }),
        ipAddress: "2.2.2.2",
      }),
    );
  });
});
