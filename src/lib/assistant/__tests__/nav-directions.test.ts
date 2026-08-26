/**
 * A direction that leads nowhere is worse than no direction.
 *
 * PAGE_FACTS is what the assistant reads back when somebody asks where a thing
 * lives. Fourteen of its forty entries told people to open a page "from the
 * left nav" for a page that is not in the left nav. Some of those routes are
 * hidden on purpose, so the pages were fine; the instruction was wrong. A user
 * who follows it scans the rail, does not find it, and concludes the feature
 * does not exist.
 *
 * This is the check that keeps the two in step. It fires on the DIRECTIVE form
 * ("from the left nav"), not on any mention of the nav, because the correct
 * fix for a hidden page is a sentence saying it is not in the rail, and a test
 * that cannot tell those apart would forbid the fix.
 *
 * Two ways to satisfy it: put the page in the rail, or stop telling people it
 * is there. Both are one line, and picking is a judgement about whether the
 * page deserves a slot rather than a thing to work around.
 */
import { PAGE_FACTS } from "@/lib/assistant/page-facts";
import { NAV_ITEMS } from "@/lib/dashboard-nav";

const NAV_HREFS = new Set(NAV_ITEMS.map((n) => n.href));

/** The directive form only. "It is not in the left nav" is a correction. */
const DIRECTS_TO_NAV = /from the left nav/i;

function reachableFromRail(route: string): boolean {
  if (NAV_HREFS.has(route)) return true;
  /* A nav entry deeper than the route still reaches it: "/hr/documents" in the
     rail means somebody looking for "/hr" finds a way in. */
  return [...NAV_HREFS].some((h) => h.startsWith(route + "/"));
}

describe("what the assistant tells people about the left nav", () => {
  it("only sends them there for pages that are actually there", () => {
    const liars = Object.entries(PAGE_FACTS)
      .filter(([, f]) => f.how_to.some((step) => DIRECTS_TO_NAV.test(step)))
      .filter(([, f]) => !reachableFromRail(f.route))
      .map(([key, f]) => `${key} -> ${f.route}`);

    expect(liars).toEqual([]);
  });

  /* The correction is a real sentence people read, so it has to name the route
     it is redirecting them to. "It is not in the left nav" on its own leaves
     somebody with less than they started with. */
  it("gives a route whenever it says a page is not in the nav", () => {
    const unhelpful = Object.entries(PAGE_FACTS)
      .flatMap(([key, f]) => f.how_to.map((step) => [key, f.route, step] as const))
      .filter(([, , step]) => /not in the left nav/i.test(step))
      .filter(([, route, step]) => !step.includes(route))
      .map(([key]) => key);

    expect(unhelpful).toEqual([]);
  });

  /* The page the operator asked to be visible to their team. Named
     explicitly, because "it is in PAGE_FACTS" is what was true while it was
     unreachable. */
  it("keeps the client playbook in the rail", () => {
    expect(NAV_HREFS.has("/playbook")).toBe(true);
  });
});
