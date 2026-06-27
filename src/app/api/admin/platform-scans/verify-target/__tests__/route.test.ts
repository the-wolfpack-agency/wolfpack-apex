/**
 * Contract for /api/admin/platform-scans/verify-target.
 * POST action:issue -> issues a token (fires target_verification_requested).
 * POST action:check -> runs the proof check. Gated on settings.manage_team.
 * Store, analytics, and audit are mocked - no DB/network.
 */
const mockIssue = jest.fn();
const mockCheck = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({ ok: true, user: { id: "a", role: "cto", workspaceId: "ws-1" } });

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/authorization", () => ({
  issueVerificationToken: (...a: unknown[]) => mockIssue(...a),
  checkVerification: (...a: unknown[]) => mockCheck(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => { mockAudit(...a); return Promise.resolve(); },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/verify-target/route";

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/admin/platform-scans/verify-target", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "a", role: "cto", workspaceId: "ws-1" } });
  mockIssue.mockResolvedValue({ token: "t".repeat(64), status: "pending", verifiedAt: null, instructions: [] });
  mockCheck.mockResolvedValue({ ok: true, method: "http_well_known", status: "verified", verifiedAt: "2026-06-27T00:00:00Z" });
});

describe("POST issue", () => {
  it("200, returns token + instructions, tracks request, audits", async () => {
    const res = await post({ platform: "acme", action: "issue" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, platform: "acme", status: "pending" });
    expect(body.token).toHaveLength(64);
    expect(mockIssue).toHaveBeenCalledWith("ws-1", "acme");
    expect(mockTrack).toHaveBeenCalledWith("platform.target_verification_requested", "a", "cto", expect.objectContaining({ platform: "acme" }));
    expect(mockAudit).toHaveBeenCalled();
  });
});

describe("POST check", () => {
  it("200 verified true on success", async () => {
    const res = await post({ platform: "acme", action: "check", method: "http_well_known" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "verified", method: "http_well_known" });
    expect(mockCheck).toHaveBeenCalledWith("ws-1", "acme", "http_well_known", { userId: "a", role: "cto" });
    expect(mockAudit).toHaveBeenCalled();
  });

  it("200 ok:false with reason on failure", async () => {
    mockCheck.mockResolvedValue({ ok: false, method: "dns_txt", status: "failed", verifiedAt: null, reason: "token_mismatch" });
    const res = await post({ platform: "acme", action: "check", method: "dns_txt" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "failed", reason: "token_mismatch" });
  });

  it("400 method_invalid when method is not a supported method", async () => {
    const res = await post({ platform: "acme", action: "check", method: "carrier_pigeon" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("method_invalid");
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe("validation + auth", () => {
  it("400 platform_required when platform missing", async () => {
    const res = await post({ action: "issue" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("platform_required");
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("400 action_invalid for an unknown action", async () => {
    const res = await post({ platform: "acme", action: "wat" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("action_invalid");
  });

  it("403 when the capability gate fails, never touches the lib", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await post({ platform: "acme", action: "issue" });
    expect(res.status).toBe(403);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
