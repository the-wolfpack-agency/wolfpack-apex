/**
 * Places a system disagrees with itself.
 *
 * A scanner reports whether a page has a protection. It does not report that
 * eleven pages have it and one does not, which is a different and often more
 * useful fact. A missing header everywhere is a decision somebody made; a
 * missing header on one page out of twelve is almost always an accident, and
 * the accident is the thing worth telling a client about.
 *
 * It is also what makes these cheap to act on. "Add a security header to your
 * estate" is a project. "This one route is missing the header the other eleven
 * have" is an afternoon.
 */
import { findInconsistencies } from "@/lib/platform-scan/mapping/consistency";
import type { PageObservation } from "@/lib/platform-scan/mapping/data-flow";

const page = (
  url: string,
  headerNames: string[] = [],
  status = 200,
): PageObservation => ({ url, status, headerNames });

const HSTS = "strict-transport-security";

/** n pages that all carry the given headers. */
const many = (n: number, headers: string[], prefix = "/p") =>
  Array.from({ length: n }, (_, i) => page(`${prefix}${i}`, headers));

describe("what counts as an inconsistency", () => {
  it("reports the one page missing what the rest have", () => {
    const pages = [...many(11, [HSTS]), page("/odd-one-out", [])];
    const found = findInconsistencies(pages);

    expect(found).toHaveLength(1);
    expect(found[0].outliers).toEqual(["/odd-one-out"]);
    expect(found[0].majorityCount).toBe(11);
    expect(found[0].title).toMatch(/missing/i);
  });

  /* Absence is not the signal. A site that never sets a header has not
     disagreed with itself, and reporting it here would duplicate the
     scanner while burying the accidents. */
  it("says nothing when no page has it", () => {
    expect(findInconsistencies(many(8, []))).toEqual([]);
  });

  it("says nothing when every page has it", () => {
    expect(findInconsistencies(many(8, [HSTS]))).toEqual([]);
  });

  /* Which side is the outlier depends on the site, not on which we would have
     preferred. One page that sets a header nobody else does is equally a sign
     something was applied in one place only. */
  it("reports the minority even when the minority is the one with the header", () => {
    const pages = [...many(11, []), page("/only-secure-page", [HSTS])];
    const found = findInconsistencies(pages);

    expect(found[0].outliers).toEqual(["/only-secure-page"]);
    expect(found[0].title).toMatch(/when the rest do not/i);
  });

  /* Four and eight is two groups, not a mistake, and calling it an error would
     be wrong about the system. */
  it("does not call an even split an accident", () => {
    const pages = [...many(6, [HSTS], "/a"), ...many(6, [], "/b")];
    expect(findInconsistencies(pages)).toEqual([]);
  });

  it("needs enough pages for a majority to exist", () => {
    expect(findInconsistencies([page("/a", [HSTS]), page("/b", [])])).toEqual([]);
  });
});

describe("which pages count", () => {
  /* A 404 has no obligation to carry a security policy, and counting one as a
     gap produces a finding about a page that does not exist. */
  it("ignores pages that were not served", () => {
    const pages = [...many(8, [HSTS]), page("/missing", [], 404), page("/gone", [], 500)];
    expect(findInconsistencies(pages)).toEqual([]);
  });

  it("counts a redirect as served, because it was", () => {
    const pages = [...many(8, [HSTS]), page("/moved", [], 301)];
    const found = findInconsistencies(pages);
    expect(found[0].outliers).toEqual(["/moved"]);
  });
});

describe("coverage of the headers it checks", () => {
  it.each([
    ["content-security-policy", /content security policy/i],
    ["x-content-type-options", /content-type protection/i],
    ["x-frame-options", /clickjacking/i],
  ])("reports an inconsistent %s", (header, label) => {
    const pages = [...many(9, [header]), page("/odd", [])];
    const found = findInconsistencies(pages);
    expect(found[0].title).toMatch(label);
  });

  it("reports each header separately, so a fix can be scoped", () => {
    const pages = [...many(9, [HSTS, "x-frame-options"]), page("/odd", [])];
    const found = findInconsistencies(pages);
    expect(found).toHaveLength(2);
  });
});
