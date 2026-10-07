/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockSet = jest.fn();
const mockGet = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/forcefield-web/billing", () => ({
  setTenantBilling: (...a: unknown[]) => mockSet(...a),
  getTenantBilling: (...a: unknown[]) => mockGet(...a),
  FORCEFIELD_PLANS: ["none", "starter", "growth", "scale", "enterprise"],
  SUBSCRIPTION_STATUSES: ["none", "trialing", "active", "past_due", "canceled"],
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { POST } from "../route";
const OK = { ok: true, user: { id: "op1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (b: unknown) => new NextRequest("http://x", { method: "POST", body: JSON.stringify(b) });
beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

it("401/403 when denied", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await POST(post({ id: "t1", plan: "growth" }))).status).toBe(401);
});
it("400 on invalid plan / status", async () => {
  mockRequireCapability.mockResolvedValue(OK);
  expect((await POST(post({ id: "t1", plan: "platinum" }))).status).toBe(400);
  expect((await POST(post({ id: "t1", status: "maybe" }))).status).toBe(400);
});
it("200 sets the license (provider forced to manual) + audited", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockSet.mockResolvedValueOnce(true);
  mockGet.mockResolvedValueOnce({ plan: "growth", status: "active", provider: "manual", billingRef: null, currentPeriodEnd: null });
  const res = await POST(post({ id: "t1", plan: "growth", status: "active" }));
  expect(res.status).toBe(200);
  expect((await res.json()).billing.plan).toBe("growth");
  expect(mockSet).toHaveBeenCalledWith("t1", { plan: "growth", status: "active", provider: "manual" });
  expect(mockAudit.mock.calls[0][0].action).toBe("forcefield.tenant_license_updated");
});
it("404 when the tenant does not exist", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockSet.mockResolvedValueOnce(false);
  expect((await POST(post({ id: "x", plan: "starter" }))).status).toBe(404);
});
