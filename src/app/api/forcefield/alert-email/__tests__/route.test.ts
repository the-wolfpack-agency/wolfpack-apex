/**
 * @jest-environment node
 *
 * Contract for /api/forcefield/alert-email (tenant-token scoped):
 * GET 200 / 401 / 503; PUT 200 pending (audited, tracked) / 400 / 401 / 403
 * not_allowed / 429 / 503; DELETE 200 / 401 / 503. Every call resolves the
 * tenant from the presented token only, so a request can only touch its own
 * tenant.
 */
import { NextRequest } from "next/server";

const mockResolve = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockRemove = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/tenants", () => ({ resolveTenantByToken: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/forcefield-web/tenant-notify", () => ({
  getNotifyState: (...a: unknown[]) => mockGet(...a),
  setNotifyEmail: (...a: unknown[]) => mockSet(...a),
  removeNotifyEmail: (...a: unknown[]) => mockRemove(...a),
  CONFIRM_SEND_WINDOW_MS: 3_600_000,
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { GET, PUT, DELETE } from "../route";

const req = (method: string, token?: string, body?: unknown) =>
  new NextRequest("http://x/api/forcefield/alert-email", { method, headers: token ? { "x-forcefield-token": token } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
  mockResolve.mockImplementation(async (t: string) => (t === "ff_ok" ? { id: "t1", siteLabel: "acme.com" } : null));
});

it("401 on every method without a recognized token", async () => {
  expect((await GET(req("GET"))).status).toBe(401);
  expect((await PUT(req("PUT", "ff_bad", { email: "a@thewolfpack.agency" }))).status).toBe(401);
  expect((await DELETE(req("DELETE", "ff_bad"))).status).toBe(401);
  expect(mockSet).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
});

it("GET 200 returns the tenant's own state (+ restricted flag); 503 on a read error", async () => {
  mockGet.mockResolvedValueOnce({ email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x" });
  const res = await GET(req("GET", "ff_ok"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, notify: { email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x", restricted: true } });
  expect(mockGet).toHaveBeenCalledWith("t1");
  mockGet.mockResolvedValueOnce(null);
  expect((await GET(req("GET", "ff_ok"))).status).toBe(503);
});

it("PUT 200 pending: audited with the domain only, tracked", async () => {
  mockSet.mockResolvedValueOnce({ ok: true, reason: "ok", delivered: true });
  const res = await PUT(req("PUT", "ff_ok", { email: "qa@thewolfpack.agency" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, status: "pending", delivered: true });
  expect(mockSet).toHaveBeenCalledWith("t1", "qa@thewolfpack.agency");
  expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.alert_email_set", resourceId: "t1", afterState: { emailDomain: "thewolfpack.agency" } });
  expect(mockTrack).toHaveBeenCalledWith("forcefield.alert_email_set", "forcefield_tenant:t1", "tenant", { tenantId: "t1", delivered: true });
});

it.each([
  ["invalid", 400],
  ["not_allowed", 403],
  ["rate_limited", 429],
  ["not_found", 401],
  ["error", 503],
])("PUT maps %s to %i", async (reason, status) => {
  mockSet.mockResolvedValueOnce({ ok: false, reason });
  const res = await PUT(req("PUT", "ff_ok", { email: "x@thewolfpack.agency" }));
  expect(res.status).toBe(status);
  if (status === 429) expect(res.headers.get("Retry-After")).toBe("3600");
});

it("PUT 400 when the body has no string email", async () => {
  expect((await PUT(req("PUT", "ff_ok", { email: 5 }))).status).toBe(400);
  expect(mockSet).not.toHaveBeenCalled();
});

it("DELETE 200 removes and audits; 503 on error", async () => {
  mockRemove.mockResolvedValueOnce({ ok: true, reason: "ok" });
  expect((await DELETE(req("DELETE", "ff_ok"))).status).toBe(200);
  expect(mockRemove).toHaveBeenCalledWith("t1");
  expect(mockAudit.mock.calls[0][0].action).toBe("forcefield.alert_email_removed");
  mockRemove.mockResolvedValueOnce({ ok: false, reason: "error" });
  expect((await DELETE(req("DELETE", "ff_ok"))).status).toBe(503);
});
