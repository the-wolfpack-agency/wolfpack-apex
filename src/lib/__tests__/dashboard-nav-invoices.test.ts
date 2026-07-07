/**
 * Nav-gate tests for the unified "Invoices" hub item. The sidebar, the
 * NavCustomizer and the Cmd+K palette all funnel through canSeeNavItem, so this
 * one gate decides visibility everywhere. It is OR-gated: a finance-role user
 * (AP queue) OR a named PCNA tracker viewer (who may hold no finance role) sees
 * it; someone who is neither never does.
 */
import { NAV_ITEMS, canSeeNavItem } from "../dashboard-nav";

const invoices = NAV_ITEMS.find((i) => i.href === "/invoices")!;
const dashboard = NAV_ITEMS.find((i) => i.href === "/")!;

describe("Invoices hub nav gate", () => {
  it("registers a single /invoices item gated by finance roles AND the PCNA viewers", () => {
    expect(invoices).toBeDefined();
    expect(invoices.label).toBe("Invoices");
    expect(invoices.roles).toEqual(expect.arrayContaining(["cto", "ceo"]));
    expect(invoices.emails).toEqual(
      expect.arrayContaining([
        "homyk@thewolfpack.agency",
        "nick@thewolfpack.agency",
        "jorge@thewolfpack.agency",
      ]),
    );
  });

  it("has exactly one Invoices nav item (no /finance/invoices duplicate)", () => {
    expect(NAV_ITEMS.filter((i) => i.label === "Invoices")).toHaveLength(1);
    expect(NAV_ITEMS.find((i) => i.href === "/finance/invoices")).toBeUndefined();
  });

  it("shows Invoices to a finance-role user regardless of email", () => {
    expect(canSeeNavItem(invoices, "cto", "someone.finance@thewolfpack.agency")).toBe(true);
    expect(canSeeNavItem(invoices, "ceo", null)).toBe(true);
  });

  it("shows Invoices to a PCNA viewer even without a finance role (case-insensitive)", () => {
    expect(canSeeNavItem(invoices, "member", "jorge@thewolfpack.agency")).toBe(true);
    expect(canSeeNavItem(invoices, "member", "NICK@thewolfpack.agency")).toBe(true);
  });

  it("hides Invoices from someone who is neither finance nor a viewer", () => {
    expect(canSeeNavItem(invoices, "member", "stranger@thewolfpack.agency")).toBe(false);
    expect(canSeeNavItem(invoices, "member", "")).toBe(false);
    expect(canSeeNavItem(invoices, "member", null)).toBe(false);
  });

  it("leaves unrestricted items visible regardless of role/email", () => {
    expect(canSeeNavItem(dashboard, "member", null)).toBe(true);
    expect(canSeeNavItem(dashboard, "member", "anyone@thewolfpack.agency")).toBe(true);
  });
});
