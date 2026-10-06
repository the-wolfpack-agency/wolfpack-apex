/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/signups (operator review). Asserts auth
 * (401/403), GET lists without a token, approve returns 201 with the token +
 * quick-start and is audited (never the token), reject is 200 and audited,
 * invalid action is 400, and the not-found / already-reviewed states map to
 * 404 / 409. The lib is mocked so the contract needs no database.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockList = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();
const mockRecordAudit = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/forcefield-web/signup", () => ({
  listSignupRequests: (...a: unknown[]) => mockList(...a),
  approveSignupRequest: (...a: unknown[]) => mockApprove(...a),
  rejectSignupRequest: (...a: unknown[]) => mockReject(...a),
}));
jest.mock("@/lib/forcefield-web/tenant-quickstart", () => ({
  buildTenantQuickstart: () => ({ token: "ff_minted", cloudflareEnv: { SITE_ANALYTICS_INGEST_TOKEN: "ff_minted" }, nextEnv: {}, nextSnippet: "x" }),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { GET, POST } from "../route";

const OK = { ok: true, user: { id: "op-1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const TENANT = { id: "t-9", name: "Acme", siteLabel: "acme.com", status: "active", createdAt: "2026-10-06T00:00:00Z" };
const post = (body: unknown) =>
  new NextRequest("http://x/api/admin/forcefield/signups", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRecordAudit.mockResolvedValue(undefined); });

describe("GET", () => {
  it("401/403 when the capability check denies", async () => {
    mockRequireCapability.mockResolvedValueOnce(deny(401));
    expect((await GET(new NextRequest("http://x"))).status).toBe(401);
    mockRequireCapability.mockResolvedValueOnce(deny(403));
    expect((await GET(new NextRequest("http://x"))).status).toBe(403);
  });
  it("lists pending requests and leaks no token", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockList.mockResolvedValueOnce([{ id: "r1", name: "A", email: "a@x.com", siteUrl: "x.com", note: null, status: "pending", tenantId: null, createdAt: "2026-10-06T00:00:00Z" }]);
    const res = await GET(new NextRequest("http://x/api/admin/forcefield/signups"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });
});

describe("POST", () => {
  it("403 when denied, lib untouched", async () => {
    mockRequireCapability.mockResolvedValueOnce(deny(403));
    expect((await POST(post({ id: "r1", action: "approve" }))).status).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("400 on an invalid action", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    const res = await POST(post({ id: "r1", action: "nope" }));
    expect(res.status).toBe(400);
  });

  it("approve -> 201 with token + quick-start, audited without the token", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockApprove.mockResolvedValueOnce({ ok: true, reason: "ok", tenant: TENANT, token: "ff_minted" });
    const res = await POST(post({ id: "r1", action: "approve" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe("ff_minted");
    expect(body.quickstart.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_minted");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("forcefield.signup_approved");
    expect(JSON.stringify(audit)).not.toContain("ff_minted");
    expect(mockTrack).toHaveBeenCalledWith("forcefield.signup_approved", "op-1", "admin", { requestId: "r1", tenantId: "t-9" });
  });

  it("approve -> 409 when already reviewed", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockApprove.mockResolvedValueOnce({ ok: false, reason: "already_reviewed" });
    expect((await POST(post({ id: "r1", action: "approve" }))).status).toBe(409);
  });

  it("approve -> 404 when not found", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockApprove.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await POST(post({ id: "r1", action: "approve" }))).status).toBe(404);
  });

  it("reject -> 200 and audited", async () => {
    mockRequireCapability.mockResolvedValueOnce(OK);
    mockReject.mockResolvedValueOnce({ ok: true, reason: "ok" });
    const res = await POST(post({ id: "r1", action: "reject" }));
    expect(res.status).toBe(200);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.signup_rejected");
  });
});
