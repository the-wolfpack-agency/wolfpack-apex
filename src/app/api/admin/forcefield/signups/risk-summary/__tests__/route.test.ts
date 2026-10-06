/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/signups/risk-summary. Asserts auth (401/403),
 * 400 without an id, 404 for an unknown request, a 200 ADVISORY body on success
 * (and still 200 when the summary is unavailable - it never blocks the review),
 * and that the operator action is audited. Libs are mocked; no DB, no model.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGet = jest.fn();
const mockSummarize = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/forcefield-web/signup", () => ({
  getSignupRequest: (...a: unknown[]) => mockGet(...a),
}));
jest.mock("@/lib/forcefield-web/signup-risk-summary", () => ({
  summarizeSignupRisk: (...a: unknown[]) => mockSummarize(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));

import { POST } from "../route";

const OK = { ok: true, user: { id: "op-1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const REQ = { id: "r1", name: "Dana", email: "dana@acme.com", siteUrl: "acme.com", note: null, status: "pending", tenantId: null, createdAt: "2026-10-06T00:00:00Z" };
const post = (body: unknown) =>
  new NextRequest("http://x/api/admin/forcefield/signups/risk-summary", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockRecordAudit.mockResolvedValue(undefined); });

it("401/403 when the capability check denies", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await POST(post({ id: "r1" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValueOnce(deny(403));
  expect((await POST(post({ id: "r1" }))).status).toBe(403);
  expect(mockSummarize).not.toHaveBeenCalled();
});

it("400 without an id", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  expect((await POST(post({}))).status).toBe(400);
});

it("404 when the request does not exist", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockGet.mockResolvedValueOnce(null);
  expect((await POST(post({ id: "nope" }))).status).toBe(404);
  expect(mockSummarize).not.toHaveBeenCalled();
});

it("200 with the summary on success, scoped to the operator's workspace, and audited", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockGet.mockResolvedValueOnce(REQ);
  mockSummarize.mockResolvedValueOnce({ ok: true, summary: "Looks legit.", model: "gpt-4o-mini", degraded: false });
  const res = await POST(post({ id: "r1" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, summary: "Looks legit.", model: "gpt-4o-mini", degraded: false });
  // routed with workspace + actor context
  expect(mockSummarize).toHaveBeenCalledWith(
    { name: "Dana", email: "dana@acme.com", siteUrl: "acme.com", note: null },
    { workspaceId: "w1", actor: { userId: "op-1", role: "admin" } },
  );
  expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  expect(mockRecordAudit.mock.calls[0][0].action).toBe("forcefield.signup_risk_summarized");
});

it("still 200 (advisory) when the summary is unavailable - never blocks the review", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockGet.mockResolvedValueOnce(REQ);
  mockSummarize.mockResolvedValueOnce({ ok: false, reason: "no_provider" });
  const res = await POST(post({ id: "r1" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false, reason: "no_provider" });
});
