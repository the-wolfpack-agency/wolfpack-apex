/**
 * Contract tests for /api/team/accept.
 *
 * Locked behaviors:
 *   - 400 missing token / password
 *   - 400 password under 8 chars (was 4 — tightened 2026-05-08)
 *   - 404 token not found
 *   - 409 already-accepted invite
 *   - 200 happy path: writes member with bcrypt hash, marks invite accepted,
 *     fires analytics + audit. INSERT + UPDATE go through writeQuery so
 *     a silent pg failure surfaces as 5xx instead of a 200 with no row.
 *   - 503 when invite SELECT comes back fromCache in prod mode (regression
 *     guard for the 2026-05-20 gmail-invite silent-write-loss incident)
 *   - 500 when team_member INSERT throws
 *   - 409 with duplicate-email hint when writeQuery hits the
 *     uq_instinct_team_members_email_lower unique-index collision
 *   - 200 in genuine shadow mode (DATABASE_URL unset): faked success
 */

export {};

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
class WriteQueryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "WriteQueryError";
  }
}
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  WriteQueryError,
}));

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
  mockWriteQuery.mockResolvedValue({ rows: [] });
  process.env.DATABASE_URL = "postgresql://test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
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

  it("200 happy path persists member via writeQuery, marks invite accepted, fires audit + analytics", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [PENDING_INVITE], fromCache: false });

    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toMatch(/^tm_/);
    expect(body.email).toBe("max@thewolfpack.agency");

    expect(mockHashPassword).toHaveBeenCalledWith("supersecret");

    // Both writes MUST go through writeQuery so silent pg failures
    // surface as exceptions, not as 200-with-no-row-written.
    expect(mockWriteQuery).toHaveBeenCalledTimes(2);
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_team_members/);
    expect(mockWriteQuery.mock.calls[1][0]).toMatch(/UPDATE instinct_invites SET status = 'accepted'/);
    // The invite is looked up by the hash of the presented token, and the
    // accepted row keeps only the hash.
    const { hashBearerToken } = await import("@/lib/crypto/token-hash");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual([hashBearerToken("abc"), "abc"]);
    expect(mockWriteQuery.mock.calls[1][1]).toEqual(["inv_a", hashBearerToken("abc")]);

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

  it("normalizes invite email to lowercase before writing the team_members row + before audit/response", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...PENDING_INVITE, email: "  Mixed.Case@Wolfpack.Agency  " }],
      fromCache: false,
    });

    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("mixed.case@wolfpack.agency");

    const insertParams = mockWriteQuery.mock.calls[0][1];
    expect(insertParams[1]).toBe("mixed.case@wolfpack.agency");
  });

  it("503 when invite SELECT comes back fromCache in prod mode (silent-write-loss regression guard)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    // The pre-2026-05-20 route returned 200 here even in prod, leaving
    // the operator unable to log in forever. New behavior: surface a
    // real failure so the operator knows to retry.
    expect(res.status).toBe(503);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("500 when team_member INSERT throws (any non-unique-constraint error)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [PENDING_INVITE], fromCache: false });
    mockWriteQuery.mockRejectedValueOnce(new WriteQueryError("connection terminated", "db_error"));

    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/could not create/i);
  });

  it("409 with duplicate-email hint when writeQuery hits uq_instinct_team_members_email_lower", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [PENDING_INVITE], fromCache: false });
    mockWriteQuery.mockRejectedValueOnce(
      new WriteQueryError(
        "writeQuery failed: duplicate key value violates unique constraint \"uq_instinct_team_members_email_lower\"",
        "db_error",
      ),
    );

    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
    expect(body.email).toBe("max@thewolfpack.agency");
  });

  it("200 shadow mode (DATABASE_URL unset): returns generated id, no writes attempted", async () => {
    delete process.env.DATABASE_URL;
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toMatch(/^tm_/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("410 when the invite has expired, and nothing is written", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...PENDING_INVITE, expires_at: new Date(Date.now() - 60_000).toISOString() }],
      fromCache: false,
    });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "abc", password: "supersecret" }));
    expect(res.status).toBe(410);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("404 for a wrong token: the lookup is by hash, and a raw match is limited to unhashed rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { POST } = await import("@/app/api/team/accept/route");
    const res = await POST(mkReq({ token: "wrong-token", password: "supersecret" }));
    expect(res.status).toBe(404);
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/token = \$1 OR \(token = \$2 AND token !~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});
