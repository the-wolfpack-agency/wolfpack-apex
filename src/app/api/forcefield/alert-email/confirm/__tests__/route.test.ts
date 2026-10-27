/**
 * @jest-environment node
 *
 * Contract for PUBLIC POST /api/forcefield/alert-email/confirm: 400 on a missing
 * token, 200 on success (audited + tracked), and each failure reason mapped to
 * its status, never 500.
 */
import { NextRequest } from "next/server";

const mockFn = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/tenant-notify", () => ({ confirmNotifyEmail: (...a: unknown[]) => mockFn(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";
import { readDashboardSession } from "@/lib/forcefield-web/dashboard-session";

const post = (body: unknown) => new NextRequest("http://x/api/forcefield/alert-email/confirm", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

it("400 without a token", async () => {
  expect((await POST(post({}))).status).toBe(400);
  expect((await POST(post({ token: 7 }))).status).toBe(400);
  expect(mockFn).not.toHaveBeenCalled();
});

it("200 on success, audited and tracked", async () => {
  mockFn.mockResolvedValueOnce({ ok: true, reason: "ok", tenantId: "t1", site: "acme.com" });
  const res = await POST(post({ token: "tok" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, site: "acme.com" });
  // The confirmation link is also the dashboard sign-in: a session for THIS tenant.
  expect(readDashboardSession(body.dashboardToken)).toBe("t1");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(mockTrack).toHaveBeenCalledWith("forcefield.dashboard_signed_in", "forcefield_tenant:t1", "tenant", { tenantId: "t1", via: "confirm_link" });
  expect(mockFn).toHaveBeenCalledWith("tok");
  expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.alert_email_confirmed", resourceId: "t1" });
  expect(mockTrack.mock.calls[0][0]).toBe("forcefield.alert_email_confirmed");
});

it.each([
  ["invalid", 400],
  ["not_found", 404],
  ["already_confirmed", 409],
  ["expired", 410],
  ["error", 503],
])("%s -> %i", async (reason, status) => {
  mockFn.mockResolvedValueOnce({ ok: false, reason });
  const res = await POST(post({ token: "tok" }));
  expect(res.status).toBe(status);
  expect(mockAudit).not.toHaveBeenCalled();
});
