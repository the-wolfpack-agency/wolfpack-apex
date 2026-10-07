/**
 * Dependency-free Stripe sync: HMAC signature verification + subscription-event
 * mapping. Proves a valid signature passes, a forged/stale one fails, and an event
 * maps to the right tenant billing update.
 */
import { createHmac } from "crypto";
import { verifyStripeSignature, mapStripeStatus, subscriptionEventToBilling } from "../billing-stripe";

const SECRET = "whsec_test";
function sign(payload: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyStripeSignature", () => {
  const now = 1_000_000;
  it("accepts a correctly-signed, fresh payload", () => {
    const payload = '{"hello":"world"}';
    expect(verifyStripeSignature(payload, sign(payload, now), SECRET, now)).toBe(true);
  });
  it("rejects a wrong secret, a tampered payload, and a stale timestamp", () => {
    const payload = '{"a":1}';
    expect(verifyStripeSignature(payload, sign(payload, now, "wrong"), SECRET, now)).toBe(false);
    expect(verifyStripeSignature('{"a":2}', sign(payload, now), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, now - 10_000), SECRET, now)).toBe(false); // outside tolerance
  });
  it("rejects a missing header or secret", () => {
    expect(verifyStripeSignature("{}", null, SECRET, now)).toBe(false);
    expect(verifyStripeSignature("{}", "t=1,v1=x", "", now)).toBe(false);
  });
});

describe("mapStripeStatus", () => {
  it("maps Stripe statuses conservatively", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("trialing")).toBe("trialing");
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("unpaid")).toBe("canceled");
    expect(mapStripeStatus("weird")).toBe("none");
  });
});

describe("subscriptionEventToBilling", () => {
  it("maps a subscription update carrying our tenant id", () => {
    const r = subscriptionEventToBilling({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_9", status: "active", current_period_end: 1893456000, metadata: { forcefield_tenant_id: "t-9", forcefield_plan: "growth" } } },
    });
    expect(r?.tenantId).toBe("t-9");
    expect(r?.input).toMatchObject({ status: "active", provider: "stripe", billingRef: "sub_9", plan: "growth" });
    expect(r?.input.currentPeriodEnd).toMatch(/^20\d\d-/);
  });
  it("treats a deletion as canceled", () => {
    const r = subscriptionEventToBilling({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "active", metadata: { forcefield_tenant_id: "t-1" } } } });
    expect(r?.input.status).toBe("canceled");
  });
  it("returns null for a non-subscription event or one with no tenant id", () => {
    expect(subscriptionEventToBilling({ type: "invoice.paid", data: { object: {} } })).toBeNull();
    expect(subscriptionEventToBilling({ type: "customer.subscription.updated", data: { object: { id: "s", status: "active", metadata: {} } } })).toBeNull();
  });
});
