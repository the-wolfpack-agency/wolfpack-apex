/**
 * Contract tests for /api/team/accept.
 *
 * Locked behaviors:
 *   - 400 missing token / password
 *   - 400 password under 8 chars (was 4 — tightened 2026-05-08)
 *   - 404 token not found
 *   - 409 already-accepted invite
 *   - 200 happy path: writes member with bcrypt hash, marks invite accepted,
 *     fires analytics + audit
 */
 
export {};

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));

const mockHashPassword: jest.Mock = jest.fn(() => "bcrypt-hash");
jest.mock("@/lib/auth", () => ({ hashPassword: (...a: any[]) => mockHashPassword(...a) }));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

const mockRecordAudit = jest.fn();
const mockExtractMeta: jest.Mock = jest.fn(() => ({ ipAddress: "1.1.1.1", userAgent: "test", requestId: "r1" }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: (...a: any[]) => mockExtractMeta(...a),
}));

function mkReq(body: unknown): any {
  return { json: async () => body, headers: new Headers() };
}

const PENDING_INVITE = {
  id: "inv_a",
  email: "max@thewolfpack.agency",
  role: "ops",
  status: "pending",
  invited_by: "u_cto",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("POST /api/team/accept", () => {
  it("400 missing token", async () => {
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ password: "longenough" }));
    expect(res.status).toBe(400);
  });

  it("400 missing password", async () => {
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc" }));
    expect(res.status).toBe(400);
  });

  it("400 password under 8 chars (post-tighten)", async () => {
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "short" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least 8/i);
  });

  it("404 token not found in DB", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "nope-token", password: "supersecret" }));
    expect(res.status).toBe(404);
  });

  it("409 already-accepted invite", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...PENDING_INVITE, status: "accepted" }],
      fromCache: false,
    });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(409);
  });

  it("200 happy path persists member, marks invite accepted, fires audit + analytics", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [PENDING_INVITE], fromCache: false }) // SELECT invite
      .mockResolvedValueOnce({ rows: [], fromCache: false })               // INSERT member
      .mockResolvedValueOnce({ rows: [], fromCache: false });              // UPDATE invite

    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toMatch(/^tm_/);
    // /accept-invite uses this to pre-fill the email on /login so the
    // operator can't sign in with a wrong (e.g. personal) email and
    // bounce on "Invalid credentials".
    expect(body.email).toBe("max@thewolfpack.agency");

    expect(mockHashPassword).toHaveBeenCalledWith("supersecret");

    // 1: SELECT invite, 2: INSERT member, 3: UPDATE invite to accepted
    expect(mockSafeQuery).toHaveBeenCalledTimes(3);
    expect(mockSafeQuery.mock.calls[1][0]).toMatch(/INSERT INTO instinct_team_members/);
    expect(mockSafeQuery.mock.calls[2][0]).toMatch(/UPDATE instinct_invites SET status = 'accepted'/);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.team_invite_accepted",
      expect.stringMatching(/^tm_/),
      "ops",
      expect.objectContaining({ invite_id: "inv_a" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.invite.accepted",
        afterState: expect.objectContaining({ email: "max@thewolfpack.agency", role: "ops" }),
      }),
    );
  });

  it("200 shadow mode (DATABASE_URL unset): returns generated id, no INSERT enforced", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toMatch(/^tm_/);
  });
});
