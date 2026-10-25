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
const mockCanChange = jest.fn();
const mockRequirement = jest.fn();
const mockConfirmedAt = jest.fn();
const mockVerifyCode = jest.fn();
const mockLocked = jest.fn();
const mockRecordFailure = jest.fn();
const mockClearFailures = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/auth/mfa", () => ({
  enrollMfa: (...a: unknown[]) => mockEnroll(...a),
  confirmMfa: (...a: unknown[]) => mockConfirm(...a),
  disableMfa: (...a: unknown[]) => mockDisable(...a),
  mfaStatus: (...a: unknown[]) => mockStatus(...a),
  canChangeEnrollment: (...a: unknown[]) => mockCanChange(...a),
  mfaRequirementFor: (...a: unknown[]) => mockRequirement(...a),
  confirmedAtFor: (...a: unknown[]) => mockConfirmedAt(...a),
  verifyMfaCode: (...a: unknown[]) => mockVerifyCode(...a),
  mfaChallengeLocked: (...a: unknown[]) => mockLocked(...a),
  recordMfaFailure: (...a: unknown[]) => mockRecordFailure(...a),
  clearMfaFailures: (...a: unknown[]) => mockClearFailures(...a),
  MFA_FAILURE_WINDOW_SECONDS: 900,
  MFA_MAX_FAILURES: 5,
  readCookie: (req: Request, name: string) => {
    const h = req.headers.get("cookie") ?? "";
    const m = h.split(";").map((p) => p.trim()).find((p) => p.startsWith(name + "="));
    return m ? m.slice(name.length + 1) : null;
  },
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
import { POST as challengePOST } from "../challenge/route";
import { MFA_PROOF_COOKIE, verifyMfaProof } from "@/lib/crypto/mfa-proof";

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
  [
    mockRequireCapability, mockEnroll, mockConfirm, mockDisable, mockStatus, mockTrack, mockAudit,
    mockCanChange, mockRequirement, mockConfirmedAt, mockVerifyCode, mockLocked, mockRecordFailure, mockClearFailures,
  ].forEach((m) => m.mockReset());
  // Defaults: no confirmed enrollment to protect, nothing locked, not an admin.
  mockCanChange.mockResolvedValue({ ok: true });
  mockLocked.mockReturnValue(false);
  mockRequirement.mockResolvedValue({ required: null, exempt: false, subject: false });
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

/** The Set-Cookie value for the MFA proof, or null. */
function proofCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(new RegExp(`${MFA_PROOF_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

describe("POST /api/auth/mfa/verify sets the MFA proof", () => {
  it("issues an HttpOnly proof bound to the confirmed enrollment", async () => {
    okAuth();
    const confirmedAtMs = Date.parse("2026-10-24T12:00:00Z");
    mockConfirm.mockResolvedValue({ ok: true, recoveryCodes: ["a"], confirmedAtMs });
    const res = await verifyPOST(postReq("/api/auth/mfa/verify", { code: "654321" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/HttpOnly/i);
    const proof = proofCookie(res);
    expect(verifyMfaProof(proof, { userId: "u-cto", confirmedAtMs })).toBe(true);
    expect(verifyMfaProof(proof, { userId: "someone-else", confirmedAtMs })).toBe(false);
  });
});

describe("POST /api/auth/mfa/challenge", () => {
  const confirmedAtMs = Date.parse("2026-10-01T00:00:00Z");

  it("401 when unauthenticated", async () => {
    unauth();
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(res.status).toBe(401);
    expect(mockVerifyCode).not.toHaveBeenCalled();
  });

  it("403 when capability missing", async () => {
    forbidden();
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(res.status).toBe(403);
  });

  it("gates on account.manage_mfa (reachable while the admin gate blocks everything else)", async () => {
    okAuth();
    mockConfirmedAt.mockResolvedValue(confirmedAtMs);
    mockVerifyCode.mockResolvedValue({ ok: true, usedRecoveryCode: false });
    mockStatus.mockResolvedValue({ recoveryCodesRemaining: 10 });
    await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "account.manage_mfa");
  });

  it("400 on a malformed code, without touching the enrollment", async () => {
    okAuth();
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "12" }));
    expect(res.status).toBe(400);
    expect(mockVerifyCode).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    okAuth();
    const req = new NextRequest("https://wp.test/api/auth/mfa/challenge", {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await challengePOST(req);
    expect(res.status).toBe(400);
  });

  it("400 no_enrollment when there is nothing confirmed to challenge", async () => {
    okAuth();
    mockConfirmedAt.mockResolvedValue(null);
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_enrollment");
  });

  it("400 bad_code: counts the failure, audits it, emits challenge_failed, sets no proof", async () => {
    okAuth();
    mockConfirmedAt.mockResolvedValue(confirmedAtMs);
    mockVerifyCode.mockResolvedValue({ ok: false, reason: "bad_code" });
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "000000" }));
    expect(res.status).toBe(400);
    expect(mockRecordFailure).toHaveBeenCalledWith("u-cto");
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.challenge_failed" }));
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_challenge_failed", "u-cto", "cto", expect.objectContaining({ stage: "sign_in" }));
    expect(proofCookie(res)).toBeNull();
  });

  it("429 once the failure budget is spent, with Retry-After", async () => {
    okAuth();
    mockLocked.mockReturnValue(true);
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(mockVerifyCode).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_challenge_rate_limited", "u-cto", "cto", expect.any(Object));
  });

  it("200 on a good TOTP: proof cookie bound to this user + enrollment, audit + analytics", async () => {
    okAuth();
    mockConfirmedAt.mockResolvedValue(confirmedAtMs);
    mockVerifyCode.mockResolvedValue({ ok: true, usedRecoveryCode: false });
    mockStatus.mockResolvedValue({ recoveryCodesRemaining: 10 });
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "123456" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, usedRecoveryCode: false, recoveryCodesRemaining: 10 });
    expect(mockVerifyCode).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", workspaceId: "w1" }));
    expect(mockClearFailures).toHaveBeenCalledWith("u-cto");
    expect(verifyMfaProof(proofCookie(res), { userId: "u-cto", confirmedAtMs })).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.challenge_passed" }));
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_challenge_passed", "u-cto", "cto", expect.any(Object));
  });

  it("200 on a recovery code reports it was used", async () => {
    okAuth();
    mockConfirmedAt.mockResolvedValue(confirmedAtMs);
    mockVerifyCode.mockResolvedValue({ ok: true, usedRecoveryCode: true });
    mockStatus.mockResolvedValue({ recoveryCodesRemaining: 9 });
    const res = await challengePOST(postReq("/api/auth/mfa/challenge", { code: "a1b2c-3d4e5" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ usedRecoveryCode: true, recoveryCodesRemaining: 9 });
  });
});

describe("changing a confirmed enrollment needs a step-up", () => {
  it("disable: 403 mfa_code_required without a proof or a code", async () => {
    okAuth();
    mockCanChange.mockResolvedValue({ ok: false, reason: "mfa_code_required" });
    const res = await disablePOST(postReq("/api/auth/mfa/disable", {}));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("mfa_code_required");
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it("disable: 403 bad_code counts a failure", async () => {
    okAuth();
    mockCanChange.mockResolvedValue({ ok: false, reason: "bad_code" });
    const res = await disablePOST(postReq("/api/auth/mfa/disable", { code: "000000" }));
    expect(res.status).toBe(403);
    expect(mockRecordFailure).toHaveBeenCalledWith("u-cto");
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it("disable: 429 when locked and a code is offered", async () => {
    okAuth();
    mockLocked.mockReturnValue(true);
    const res = await disablePOST(postReq("/api/auth/mfa/disable", { code: "123456" }));
    expect(res.status).toBe(429);
  });

  it("disable: passes the browser's proof cookie to the step-up and clears it on success", async () => {
    okAuth();
    mockDisable.mockResolvedValue({ wasEnrolled: true });
    const req = postReq("/api/auth/mfa/disable", {});
    req.headers.set("cookie", `${MFA_PROOF_COOKIE}=v1.proof`);
    const res = await disablePOST(req);
    expect(res.status).toBe(200);
    expect(mockCanChange).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-cto", proofToken: "v1.proof" }));
    expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${MFA_PROOF_COOKIE}=;|Max-Age=0`, "i"));
  });

  it("re-enroll: 403 without a step-up, and the old enrollment is untouched", async () => {
    okAuth();
    mockCanChange.mockResolvedValue({ ok: false, reason: "mfa_code_required" });
    const res = await enrollPOST(postReq("/api/auth/mfa/enroll", {}));
    expect(res.status).toBe(403);
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/mfa/status reports what the admin gate requires", () => {
  it("an unenrolled admin: enforced, required=enroll", async () => {
    okAuth();
    mockStatus.mockResolvedValue({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null });
    mockRequirement.mockResolvedValue({ required: "enroll", exempt: false, subject: true });
    const body = await (await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"))).json();
    expect(body).toMatchObject({ enforced: true, required: "enroll" });
  });

  it("an exempt admin: not enforced, nothing required", async () => {
    okAuth();
    mockStatus.mockResolvedValue({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null });
    mockRequirement.mockResolvedValue({ required: null, exempt: true, subject: true });
    const body = await (await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"))).json();
    expect(body).toMatchObject({ enforced: false, required: null });
  });

  it("a non-admin: not enforced, nothing required", async () => {
    okAuth();
    mockStatus.mockResolvedValue({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null });
    const body = await (await statusGET(new NextRequest("https://wp.test/api/auth/mfa/status"))).json();
    expect(body).toMatchObject({ enforced: false, required: null });
  });
});
