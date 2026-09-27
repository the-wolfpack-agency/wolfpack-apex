/**
 * activeNavHref: most-specific-wins active-nav match. The regression it guards:
 * a parent href (/admin/ai-code, "Code Gate") stayed highlighted on a child
 * route (/admin/ai-code/overview, "Code Governance"), so two nav items lit up
 * at once.
 */
import { activeNavHref } from "@/lib/dashboard-nav";

const HREFS = ["/", "/admin/ai-code", "/admin/ai-code/overview", "/admin/forcefield", "/admin/forcefield-web"];

describe("activeNavHref", () => {
  it("lights ONLY the child on a child route (the two-items-lit bug)", () => {
    expect(activeNavHref("/admin/ai-code/overview", HREFS)).toBe("/admin/ai-code/overview");
  });

  it("lights the parent on the parent route", () => {
    expect(activeNavHref("/admin/ai-code", HREFS)).toBe("/admin/ai-code");
  });

  it("lights the parent on an unlisted deeper child", () => {
    expect(activeNavHref("/admin/ai-code/runs/42", HREFS)).toBe("/admin/ai-code");
  });

  it("does NOT prefix-match across a partial segment", () => {
    // /admin/forcefield must not match /admin/forcefield-web and vice versa.
    expect(activeNavHref("/admin/forcefield-web", HREFS)).toBe("/admin/forcefield-web");
    expect(activeNavHref("/admin/forcefield", HREFS)).toBe("/admin/forcefield");
  });

  it("matches home only exactly", () => {
    expect(activeNavHref("/", HREFS)).toBe("/");
    expect(activeNavHref("/admin/ai-code", HREFS)).not.toBe("/");
  });

  it("returns null when nothing matches", () => {
    expect(activeNavHref("/nope", ["/admin/ai-code"])).toBeNull();
  });
});
