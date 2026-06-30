/**
 * Contract tests for the /api/auth/mfa/* routes.
 *
 * Proves: 200 happy paths, 401 unauth, 403 missing capability, 400 bad code,
 * that recordAudit fires on mutations + analytics events fire, and that the
 * routes are user/workspace-scoped from the JWT (no IDOR — the route never
 * reads a target user id from the body).
 */

const mockRequireCapability = jest.fn();
const mockEnroll = jest.fn();
const mockConfirm = jest.fn();
const mockDisable = jest.fn();
const mockStatus = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/auth/mfa", () => ({
  enrollMfa: (...a: unknown[]) => mockEnroll(...a),
  confirmMfa: (...a: unknown[]) => mockConfirm(...a),
  disableMfa: (...a: unknown[]) => mockDisable(...a),
  mfaStatus: (...a: unknown[]) => mockStatus(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({}),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST as enrollPOST } from "../enroll/route";
import { POST as verifyPOST } from "../verify/route";
import { POST as disablePOST } from "../disable/route";
import { GET as statusGET } from "../status/route";

const USER = { id: "u-cto", role: "cto", email: "cto@wolfpack.dev", workspaceId: "w1" };

function okAuth() {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set(["account.manage_mfa"]) });
}
function unauth() {
  mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
}
function forbidden() {
  mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
}

function postReq(path: string, body?: unknown) {
  return new NextRequest(`https://wp.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  [mockRequireCapability, mockEnroll, mockConfirm, mockDisable, mockStatus, mockTrack, mockAudit].forEach((m) => m.mockReset());
});

describe("POST /api/auth/mfa/enroll", () => {
  it("401 when unauthenticated", async () => {
    unauth();
    const res = await enrollPOST(postReq("/api/auth/mfa/enroll"));
    expect(res.status).toBe(401);
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it("403 when capability missing", async () => {
    forbidden();
    const res = await enrollPOST(postReq("/api/auth/mfa/enroll"));
    expect(res.status).toBe(403);
  });

  it("gates on account.manage_mfa", async () => {
    okAuth();
    mockEnroll.mockResolvedValue({ secret: "S", otpauthUrl: "otpauth://x" });
    await enrollPOST(postReq("/api/auth/mfa/enroll"));
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "account.manage_mfa");
  });

  it("200 returns secret + otpauthUrl, audits, emits analytics, scoped to JWT user", async () => {
    okAuth();
    mockEnroll.mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x" });
    const res = await enrollPOST(postReq("/api/auth/mfa/enroll"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(body.otpauthUrl).toMatch(/^otpauth:/);
    // user id comes from JWT, never the body (no IDOR)
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", workspaceId: "w1" }));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_enrolled", "u-cto", "cto", expect.any(Object));
  });

  it("500 when enrollment write fails", async () => {
    okAuth();
    mockEnroll.mockResolvedValue(null);
    const res = await enrollPOST(postReq("/api/auth/mfa/enroll"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/auth/mfa/verify", () => {
  it("401 when unauthenticated", async () => {
    unauth();
    const res = await verifyPOST(postReq("/api/auth/mfa/verify", { code: "123456" }));
    expect(res.status).toBe(401);
  });

  it("400 on a non-6-digit code", async () => {
    okAuth();
    const res = await verifyPOST(postReq("/api/auth/mfa/verify", { code: "12" }));
    expect(res.status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("400 when the code does not verify, audits + emits challenge_failed", async () => {
    okAuth();
    mockConfirm.mockResolvedValue({ ok: false, reason: "bad_code" });
    const res = await verifyPOST(postReq("/api/auth/mfa/verify", { code: "000000" }));
    expect(res.status).toBe(400);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_challenge_failed", "u-cto", "cto", expect.any(Object));
  });

  it("200 happy path returns recovery codes, audits verified, emits analytics", async () => {
    okAuth();
    mockConfirm.mockResolvedValue({ ok: true, recoveryCodes: ["a-1", "b-2"] });
    const res = await verifyPOST(postReq("/api/auth/mfa/verify", { code: "654321" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recoveryCodes).toEqual(["a-1", "b-2"]);
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", workspaceId: "w1" }));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_verified", "u-cto", "cto", expect.any(Object));
  });
});

describe("POST /api/auth/mfa/disable", () => {
  it("401 unauth", async () => {
    unauth();
    const res = await disablePOST(postReq("/api/auth/mfa/disable"));
    expect(res.status).toBe(401);
  });

  it("403 missing capability", async () => {
    forbidden();
    const res = await disablePOST(postReq("/api/auth/mfa/disable"));
    expect(res.status).toBe(403);
  });

  it("200 disables, audits, emits analytics, scoped to JWT user", async () => {
    okAuth();
    mockDisable.mockResolvedValue({ wasEnrolled: true });
    const res = await disablePOST(postReq("/api/auth/mfa/disable"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasEnrolled).toBe(true);
    expect(mockDisable).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", workspaceId: "w1" }));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_disabled", "u-cto", "cto", expect.any(Object));
  });
});

describe("GET /api/auth/mfa/status", () => {
  it("401 unauth", async () => {
    unauth();
    const res = await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"));
    expect(res.status).toBe(401);
  });

  it("403 missing capability", async () => {
    forbidden();
    const res = await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"));
    expect(res.status).toBe(403);
  });

  it("200 returns the caller's status (read-only, no audit), scoped to JWT user", async () => {
    okAuth();
    mockStatus.mockResolvedValue({ enrolled: true, confirmed: true, recoveryCodesRemaining: 9, confirmedAt: "2026-01-01T00:00:00Z" });
    const res = await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.confirmed).toBe(true);
    expect(body.recoveryCodesRemaining).toBe(9);
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", workspaceId: "w1" }));
    expect(mockAudit).not.toHaveBeenCalled(); // read => no audit
  });
});
