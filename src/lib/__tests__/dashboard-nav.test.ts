import { NAV_ITEMS } from "@/lib/dashboard-nav";

/**
 * Tools was removed from the rail on 2026-08-02 at the operator's request,
 * following the same pattern /emails already used: the route still exists and
 * is reachable by direct link, it just does not take a slot.
 *
 * Pinned because "hidden" and "deleted" are different, and the difference is
 * invisible in a diff six months from now. If someone re-adds the entry this
 * test is where they find out the removal was deliberate.
 */
describe("Tools is hidden from the rail but not removed from the product", () => {
  it("does not appear in the nav items", () => {
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain("/tools");
  });

  it("is still a route the customizer knows about, so it can be re-added", () => {
    // Being absent from the rail AND unknown to the customizer would make it
    // unreachable, which is a deletion wearing a hide's clothing.
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "dashboard-nav.ts"),
      "utf-8",
    );
    expect(source).toContain('"/tools"');
    expect(source).toMatch(/Tools is intentionally hidden/);
  });
});
