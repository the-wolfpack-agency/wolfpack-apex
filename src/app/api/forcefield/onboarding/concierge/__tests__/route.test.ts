/**
 * @jest-environment node
 *
 * Contract for PUBLIC POST /api/forcefield/onboarding/concierge: 401 with no
 * credential, an unknown setup key or an unknown tenant token; 400 on a
 * non-string note; 200 by setup key or by tenant token (audited + tracked);
 * 503 on a store error.
 */
import { NextRequest } from "next/server";

const mockConcierge = jest.fn();
const mockResolve = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/onboarding", () => ({ requestConcierge: (...a: unknown[]) => mockConcierge(...a) }));
jest.mock("@/lib/forcefield-web/tenants", () => ({ resolveTenantByToken: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";

const post = (headers: Record<string, string>, body: unknown = { note: "please" }) =>
  new NextRequest("http://x/api/forcefield/onboarding/concierge", { method: "POST", headers, body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

it("401 with no credential", async () => {
  expect((await POST(post({}))).status).toBe(401);
});

it("400 on a non-string note", async () => {
  expect((await POST(post({ "x-forcefield-setup": "ffs_k" }, { note: 5 }))).status).toBe(400);
});

it("200 by setup key, audited + tracked", async () => {
  mockConcierge.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1" });
  const res = await POST(post({ "x-forcefield-setup": "ffs_k" }));
  expect(res.status).toBe(200);
  expect(mockConcierge).toHaveBeenCalledWith({ setupKey: "ffs_k" }, "please");
  expect(mockAudit.mock.calls[0][0].action).toBe("forcefield.onboarding_concierge_requested");
  expect(mockTrack).toHaveBeenCalledWith("forcefield.onboarding_concierge_requested", "anonymous", "public", { requestId: "req-1" });
});

it("401 for an unknown setup key", async () => {
  mockConcierge.mockResolvedValueOnce({ ok: false, reason: "not_found" });
  expect((await POST(post({ "x-forcefield-setup": "ffs_bad" }))).status).toBe(401);
});

it("by tenant token: 401 unknown, 200 known (scoped to that tenant)", async () => {
  mockResolve.mockResolvedValueOnce(null);
  expect((await POST(post({ "x-forcefield-token": "ff_bad" }))).status).toBe(401);
  mockResolve.mockResolvedValueOnce({ id: "t1" });
  mockConcierge.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1" });
  expect((await POST(post({ "x-forcefield-token": "ff_ok" }))).status).toBe(200);
  expect(mockConcierge).toHaveBeenLastCalledWith({ tenantId: "t1" }, "please");
});

it("503 on a store error", async () => {
  mockConcierge.mockResolvedValueOnce({ ok: false, reason: "error" });
  expect((await POST(post({ "x-forcefield-setup": "ffs_k" }))).status).toBe(503);
});
