/**
 * Nav-gate tests for the email-restricted "Invoices" item. The sidebar, the
 * NavCustomizer and the Cmd+K palette all funnel through canSeeNavItem, so this
 * one gate decides visibility everywhere — an approved viewer sees Invoices, a
 * non-viewer never does (regardless of role), and role-only items are unaffected.
 */
import { NAV_ITEMS, canSeeNavItem } from "../dashboard-nav";

const invoices = NAV_ITEMS.find((i) => i.href === "/invoices")!;
const dashboard = NAV_ITEMS.find((i) => i.href === "/")!;

describe("Invoices nav gate", () => {
  it("registers an email-restricted Invoices item", () => {
    expect(invoices).toBeDefined();
    expect(invoices.label).toBe("Invoices");
    expect(invoices.emails).toEqual(
      expect.arrayContaining([
        "homyk@thewolfpack.agency",
        "nick@thewolfpack.agency",
        "jorge@thewolfpack.agency",
      ]),
    );
  });

  it("shows Invoices to an approved viewer (case-insensitive)", () => {
    expect(canSeeNavItem(invoices, "member", "jorge@thewolfpack.agency")).toBe(true);
    expect(canSeeNavItem(invoices, "cto", "HOMYK@thewolfpack.agency")).toBe(true);
  });

  it("hides Invoices from non-viewers and empty emails, even for an admin/cto", () => {
    expect(canSeeNavItem(invoices, "cto", "stranger@thewolfpack.agency")).toBe(false);
    expect(canSeeNavItem(invoices, "admin", "")).toBe(false);
    expect(canSeeNavItem(invoices, "member", null)).toBe(false);
  });

  it("leaves unrestricted items visible regardless of email", () => {
    expect(canSeeNavItem(dashboard, "member", null)).toBe(true);
    expect(canSeeNavItem(dashboard, "member", "anyone@thewolfpack.agency")).toBe(true);
  });
});
