/**
 * Contract tests for POST /api/auth/change-password.
 *
 * Locked behaviors:
 *   - 401 unauthenticated
 *   - 400 missing/short/identical new password
 *   - 401 current password mismatch
 *   - 409 user has no current password (forgot-password path applies)
 *   - 200 happy path: hash updated, analytics fired
 *   - 200 shadow mode (no DATABASE_URL)
 */

export {};

const mockGetUserFromRequest = jest.fn();
const mockHashPassword = jest.fn((pw: string) => `hashed_${pw}`);
const mockVerifyPassword = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUserFromRequest(...a),
  hashPassword: (...a: any[]) => mockHashPassword(...a),
  verifyPassword: (...a: any[]) => mockVerifyPassword(...a),
}));

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: any[]) => mockQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

function mkReq(body: unknown, auth = "Bearer t"): any {
  return {
    json: async () => body,
    headers: new Headers({ authorization: auth }),
  };
}

const USER = { id: "tm_u", email: "u@x.com", role: "ops", workspaceId: "default" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserFromRequest.mockReturnValue(USER);
  mockVerifyPassword.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [{ password_hash: "hashed_oldpwd" }] });
  process.env.DATABASE_URL = "postgresql://test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("POST /api/auth/change-password", () => {
  it("401 when no auth header", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "x", new_password: "y" }));
    expect(res.status).toBe(401);
  });

  it("400 missing fields", async () => {
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({}));
    expect(res.status).toBe(400);
  });

  it("400 new password under 8 chars", async () => {
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "oldpwd1!", new_password: "short" }));
    expect(res.status).toBe(400);
  });

  it("400 new password identical to current", async () => {
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "samepwd1!", new_password: "samepwd1!" }));
    expect(res.status).toBe(400);
  });

  it("401 when current password does not match stored hash", async () => {
    mockVerifyPassword.mockReturnValueOnce(false);
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "wrongpwd1!", new_password: "newpwd123!" }));
    expect(res.status).toBe(401);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.password_change_failed",
      USER.id,
      USER.role,
      expect.objectContaining({ reason: "wrong_current" }),
    );
    /* Critical: no UPDATE should fire when current password is wrong. */
    expect(mockQuery).toHaveBeenCalledTimes(1); // SELECT only
  });

  it("409 when user has no password on file", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ password_hash: null }] });
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "anypwd1!", new_password: "newpwd123!" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/forgot password/i);
  });

  it("200 happy path: UPDATE fires with new hash, success event tracked", async () => {
    /* First call = SELECT for current hash; second call = UPDATE. */
    mockQuery
      .mockResolvedValueOnce({ rows: [{ password_hash: "hashed_oldpwd1!" }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "oldpwd1!", new_password: "newpwd123!" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(mockHashPassword).toHaveBeenCalledWith("newpwd123!");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE instinct_team_members SET password_hash/),
      ["hashed_newpwd123!", USER.id],
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.password_changed",
      USER.id,
      USER.role,
      expect.objectContaining({ method: "self_service" }),
    );
  });

  it("200 shadow mode (no DATABASE_URL): no SQL, success event with mode=shadow", async () => {
    delete process.env.DATABASE_URL;
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(mkReq({ current_password: "old1234!", new_password: "new12345!" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shadow).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.password_changed",
      USER.id,
      USER.role,
      expect.objectContaining({ mode: "shadow" }),
    );
  });
});
