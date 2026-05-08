/**
 * Contract tests for /api/team/invite.
 *
 * Locked behaviors:
 *   - 401/403 without `settings.manage_team` capability
 *   - 400 invalid email
 *   - 400 invalid role
 *   - 201 happy path: writes invite row, fires analytics + audit, calls
 *     mailer with the right args, response includes acceptUrl + delivery status
 *   - mailer-failure does NOT 500 the route — invite still persists, just
 *     reports `emailDelivered: false` so the UI can surface a copyable URL
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const mockRecordAudit = jest.fn();
const mockExtractMeta: jest.Mock = jest.fn(() => ({ ipAddress: "1.1.1.1", userAgent: "test", requestId: "r1" }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: (...a: any[]) => mockExtractMeta(...a),
}));

function mkReq(body: unknown): any {
  return {
    json: async () => body,
    headers: new Headers(),
  };
}

const CTO = { id: "u_cto", email: "homyk@thewolfpack.agency", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  mockRecordAudit.mockResolvedValue(undefined);
});

describe("POST /api/team/invite (inviteFlow)", () => {
  it("403 when capability check fails", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(
      mkReq({ invites: [{ email: "x@y.com", role: "ops" }] }),
    );
    expect(res.status).toBe(403);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("400 when invites[] missing or empty", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(mkReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invites array required/i);
  });

  it("400 invalid email", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(mkReq({ invites: [{ email: "no-at-sign", role: "ops" }] }));
    expect(res.status).toBe(400);
  });

  it("400 invalid role", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(mkReq({ invites: [{ email: "x@y.com", role: "pirate" }] }));
    expect(res.status).toBe(400);
  });

  it("201 happy path: persists, calls mailer, returns acceptUrl", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const mailer = jest.fn().mockResolvedValue({ delivered: true, reason: "ok" });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(
      mkReq({ invites: [{ email: "max@thewolfpack.agency", role: "ops" }] }),
      mailer,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].email).toBe("max@thewolfpack.agency");
    expect(body.invites[0].role).toBe("ops");
    expect(body.invites[0].token).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.invites[0].acceptUrl).toContain("/accept-invite?token=");
    expect(body.invites[0].emailDelivered).toBe(true);

    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_invites/);

    expect(mailer).toHaveBeenCalledTimes(1);
    const arg = mailer.mock.calls[0][0];
    expect(arg.to).toBe("max@thewolfpack.agency");
    expect(arg.role).toBe("ops");
    expect(arg.inviterEmail).toBe(CTO.email);
    expect(arg.acceptUrl).toBe(body.invites[0].acceptUrl);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.team_member_invited",
      CTO.id,
      CTO.role,
      expect.objectContaining({ invited_email: "max@thewolfpack.agency", invited_role: "ops" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("team.invite.sent");
  });

  it("201 still 201 when mailer reports non-delivery (no_api_key) — invite persists, response says emailDelivered=false", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const mailer = jest.fn().mockResolvedValue({ delivered: false, reason: "no_api_key" });
    const { inviteFlow } = await import("@/app/api/team/invite/route");
    const res = await inviteFlow(
      mkReq({ invites: [{ email: "max@thewolfpack.agency", role: "ops" }] }),
      mailer,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invites[0].emailDelivered).toBe(false);
    expect(body.invites[0].emailReason).toBe("no_api_key");
    expect(mockSafeQuery).toHaveBeenCalled();
  });
});
