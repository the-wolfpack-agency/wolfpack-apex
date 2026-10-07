/** @jest-environment node */
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

const mockSet = jest.fn();
const mockAudit = jest.fn();
jest.mock("@/lib/forcefield-web/billing", () => ({ setTenantBilling: (...a: unknown[]) => mockSet(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "r1" }) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { POST } from "../route";

const SECRET = "whsec_test";
function signed(body: string) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return new NextRequest("http://x/api/forcefield/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${v1}` } });
}
const ORIG = process.env.STRIPE_WEBHOOK_SECRET;
beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });
afterAll(() => { if (ORIG === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = ORIG; });

it("501 disabled when no secret is configured", async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const res = await POST(new NextRequest("http://x", { method: "POST", body: "{}" }));
  expect(res.status).toBe(501);
  expect(mockSet).not.toHaveBeenCalled();
});
it("400 on a bad signature", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const res = await POST(new NextRequest("http://x", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } }));
  expect(res.status).toBe(400);
});
it("200 + syncs billing on a valid subscription event (audited)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "active", current_period_end: 1893456000, metadata: { forcefield_tenant_id: "t-9", forcefield_plan: "growth" } } } });
  const res = await POST(signed(body));
  expect(res.status).toBe(200);
  expect((await res.json()).handled).toBe(true);
  expect(mockSet).toHaveBeenCalledWith("t-9", expect.objectContaining({ status: "active", provider: "stripe", billingRef: "sub_1" }));
  expect(mockAudit.mock.calls[0][0].action).toBe("forcefield.tenant_license_updated");
});
it("200 handled:false for a verified event we do not act on", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const res = await POST(signed(JSON.stringify({ type: "invoice.paid", data: { object: {} } })));
  expect(res.status).toBe(200);
  expect((await res.json()).handled).toBe(false);
  expect(mockSet).not.toHaveBeenCalled();
});
