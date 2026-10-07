/**
 * Forcefield billing model: setTenantBilling validates enums + partial-updates,
 * getTenantBilling maps the row, isLicensed is the deterministic entitlement
 * decision. No DB (query injected); never throws.
 */
import { setTenantBilling, getTenantBilling, isLicensed } from "../billing";

describe("isLicensed", () => {
  const NOW = Date.parse("2026-10-07T12:00:00Z");
  it("active / trialing within the period is licensed", () => {
    expect(isLicensed({ status: "active", currentPeriodEnd: null }, NOW)).toBe(true);
    expect(isLicensed({ status: "trialing", currentPeriodEnd: "2026-11-01T00:00:00Z" }, NOW)).toBe(true);
  });
  it("none / past_due / canceled is not licensed", () => {
    for (const s of ["none", "past_due", "canceled"] as const) {
      expect(isLicensed({ status: s, currentPeriodEnd: null }, NOW)).toBe(false);
    }
  });
  it("active but past the period end is NOT licensed", () => {
    expect(isLicensed({ status: "active", currentPeriodEnd: "2026-10-01T00:00:00Z" }, NOW)).toBe(false);
  });
});

describe("setTenantBilling", () => {
  it("updates only the provided fields and returns true", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ id: "t1" }]);
    expect(await setTenantBilling("t1", { plan: "growth", status: "active", provider: "manual" }, q)).toBe(true);
    const sql = q.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE forcefield_tenants SET/);
    expect(sql).toMatch(/plan = \$/);
    expect(sql).toMatch(/subscription_status = \$/);
  });
  it("rejects an invalid plan or status without writing", async () => {
    const q = jest.fn();
    expect(await setTenantBilling("t1", { plan: "platinum" as never }, q)).toBe(false);
    expect(await setTenantBilling("t1", { status: "maybe" as never }, q)).toBe(false);
    expect(q).not.toHaveBeenCalled();
  });
  it("no-op when nothing to set; never throws on a DB error", async () => {
    expect(await setTenantBilling("t1", {}, jest.fn())).toBe(false);
    expect(await setTenantBilling("t1", { plan: "starter" }, jest.fn().mockRejectedValueOnce(new Error("db")))).toBe(false);
  });
});

describe("getTenantBilling", () => {
  it("maps a row and defaults unknown enum values safely", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ plan: "growth", subscription_status: "active", billing_provider: "stripe", billing_ref: "sub_1", current_period_end: "2026-11-01T00:00:00Z" }]);
    expect(await getTenantBilling("t1", q)).toEqual({ plan: "growth", status: "active", provider: "stripe", billingRef: "sub_1", currentPeriodEnd: "2026-11-01T00:00:00Z" });
  });
  it("returns null for an unknown id", async () => {
    expect(await getTenantBilling("x", jest.fn().mockResolvedValueOnce([]))).toBeNull();
  });
});
