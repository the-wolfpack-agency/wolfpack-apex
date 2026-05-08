/**
 * Contract tests for /api/auth/reset-password.
 *
 * Locks in:
 *   - 400 on missing token / missing-or-short password
 *   - 404 generic on unknown / expired / used token (no state-leak)
 *   - 200 happy path: looks up by sha256(token), hashes password,
 *     updates instinct_team_members, marks token used, fires audit
 *   - 200 shadow mode (no DB) — pretends success
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

import { createHash } from "crypto";

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));

const mockHashPassword: jest.Mock = jest.fn(async () => "bcrypt-hash");
jest.mock("@/lib/auth", () => ({ hashPassword: (...a: any[]) => mockHashPassword(...a) }));

const mockTrackEvent: jest.Mock = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

const mockRecordAudit: jest.Mock = jest.fn();
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

const TOKEN = "tok_abc";
const tokenHash = createHash("sha256").update(TOKEN).digest("hex");

function activeRow() {
  return {
    id: "pwr_1",
    member_id: "tm_1",
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    used_at: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue(undefined);
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("POST /api/auth/reset-password", () => {
  it("400 on missing token", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ password: "longenough" }));
    expect(res.status).toBe(400);
  });

  it("400 on password under 8 chars", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "short" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least 8/i);
  });

  it("404 on unknown token (no row)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "longpassword" }));
    expect(res.status).toBe(404);
  });

  it("404 on already-used token", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...activeRow(), used_at: new Date().toISOString() }],
      fromCache: false,
    });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "longpassword" }));
    expect(res.status).toBe(404);
  });

  it("404 on expired token", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        ...activeRow(),
        expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
      }],
      fromCache: false,
    });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "longpassword" }));
    expect(res.status).toBe(404);
  });

  it("200 happy path: hashes password, updates member, marks token used, fires audit + analytics", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [activeRow()], fromCache: false }) // SELECT
      .mockResolvedValueOnce({ rows: [], fromCache: false })            // UPDATE password
      .mockResolvedValueOnce({ rows: [], fromCache: false });           // UPDATE used_at

    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "longpassword" }));
    expect(res.status).toBe(200);

    expect(mockHashPassword).toHaveBeenCalledWith("longpassword");
    // Lookup uses sha256(token), not the raw token
    expect(mockSafeQuery.mock.calls[0][1][0]).toBe(tokenHash);
    expect(mockSafeQuery.mock.calls[1][0]).toMatch(/UPDATE instinct_team_members/);
    expect(mockSafeQuery.mock.calls[2][0]).toMatch(/UPDATE instinct_password_resets SET used_at = NOW\(\)/);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "auth.reset_password_completed",
      "tm_1",
      "anon",
      expect.objectContaining({ reset_id: "pwr_1" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.password.reset" }),
    );
  });

  it("200 in shadow mode (no DB), no real updates", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(mkReq({ token: TOKEN, password: "longpassword" }));
    expect(res.status).toBe(200);
    // Only the lookup ran; no UPDATE in shadow mode.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    expect(mockHashPassword).not.toHaveBeenCalled();
  });
});
