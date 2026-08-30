/**
 * The sampler, against the shape of the system that motivated it.
 *
 * The numbers here are from a real tenant: thirteen forms, each with a build,
 * a publish and an entries screen, which the first walk visited in full and
 * ran out of budget doing.
 */
import { ShapeSampler, shapesOf, SAMPLES_PER_SHAPE } from "../shapes";

const FORMS = [
  "brandambassador", "changemanagement", "coordinatorclass", "instructorclass",
  "pbaparticipant", "pcnausers", "porschecentersusa", "porschecrm",
  "porschexwolfpack", "skillspractice", "testchangemgmt", "invoicew9", "videorelease",
];
/* Breadth-first, which is the order the real walk discovers them in: every
   form's landing screen at depth one, then its sub-screens at depth two. */
const REAL_ORDER = [
  ...FORMS.map((f) => `/org/${f}/all-entries`),
  ...FORMS.flatMap((f) => ["build", "publish", "entries"].map((s) => `/org/${f}/${s}`)),
];

function walk(sampler: ShapeSampler, paths: string[]) {
  const visited: string[] = [];
  for (const p of paths) {
    sampler.note(p);
    if (sampler.isSaturated(p)) continue;
    sampler.markVisited(p);
    visited.push(p);
  }
  return visited;
}

describe("shapesOf", () => {
  it("offers one grouping per segment", () => {
    expect(shapesOf("/org/formA/build")).toEqual([
      "/*/formA/build",
      "/org/*/build",
      "/org/formA/*",
    ]);
  });

  it("gives a short path no shape, because there is nothing to generalise", () => {
    expect(shapesOf("/home")).toEqual([]);
    expect(shapesOf("/")).toEqual([]);
  });
});

describe("sampling a system that repeats itself", () => {
  it("cuts the visits roughly in half", () => {
    const visited = walk(new ShapeSampler(), REAL_ORDER);
    expect(REAL_ORDER).toHaveLength(52);
    expect(visited.length).toBeLessThan(35);
  });

  /* THE TWO THINGS IT MUST NOT LOSE. A cheaper walk that missed a form or a
     screen type would be a worse map, not a faster one. */
  it("still opens every one of the thirteen forms", () => {
    const visited = walk(new ShapeSampler(), REAL_ORDER);
    expect(new Set(visited.map((v) => v.split("/")[2])).size).toBe(FORMS.length);
  });

  it("still sees every screen type", () => {
    const visited = walk(new ShapeSampler(), REAL_ORDER);
    expect(new Set(visited.map((v) => v.split("/")[3]))).toEqual(
      new Set(["all-entries", "build", "publish", "entries"]),
    );
  });

  /* THE REGRESSION THAT MADE THE FIRST VERSION USELESS. Replacing the org
     segment yields a grouping exactly one page can ever match, so it could
     never fill, so requiring every grouping to be full meant nothing was ever
     saturated and all fifty-two were walked. */
  it("ignores a grouping only one page could ever match", () => {
    const s = new ShapeSampler(1);
    walk(s, REAL_ORDER);
    expect(s.patterns().map((p) => p.shape)).not.toContain("/*/porschecrm/build");
  });

  it("reports every instance, including the ones it did not open", () => {
    const s = new ShapeSampler();
    walk(s, REAL_ORDER);
    const build = s.patterns().find((p) => p.shape === "/org/*/build")!;
    /* The inventory survives the sampling: all thirteen are known. */
    expect(build.instances).toHaveLength(FORMS.length);
    expect(build.visited).toBeLessThanOrEqual(FORMS.length);
  });

  it("does not call a single page a pattern", () => {
    const s = new ShapeSampler();
    walk(s, ["/org/one/only"]);
    expect(s.patterns()).toEqual([]);
  });

  it("visits everything when the system does not repeat", () => {
    const distinct = ["/org/a/x", "/org/b/y", "/org/c/z"];
    expect(walk(new ShapeSampler(), distinct)).toEqual(distinct);
  });

  it("defaults to two, which is one to see and one to confirm", () => {
    expect(SAMPLES_PER_SHAPE).toBe(2);
  });
});

/**
 * The flaw a test found and reasoning did not.
 *
 * A skipped page is never read, so its links are never discovered, so
 * everything behind it vanishes from the map. Sampling the landing screens of
 * seven forms meant five forms' sub-screens were never even known to exist,
 * in a map that called itself complete.
 */
describe("sampling never prunes a branch nobody has entered", () => {
  it("always opens the first page under a parent, whatever its shape", () => {
    const s = new ShapeSampler(1);
    s.note("/org/alpha/all-entries");
    s.note("/org/bravo/all-entries");
    s.markVisited("/org/alpha/all-entries");

    /* By shape alone this is saturated. It is visited anyway, because nothing
       under /org/bravo has ever been opened and skipping it would hide
       everything that form contains. */
    expect(s.isSaturated("/org/bravo/all-entries")).toBe(false);
  });

  it("samples siblings once the branch has been entered and the shape is known", () => {
    const s = new ShapeSampler(1);
    for (const p of ["/org/alpha/build", "/org/alpha/publish", "/org/bravo/build", "/org/bravo/publish"]) s.note(p);
    s.markVisited("/org/alpha/build");
    s.markVisited("/org/bravo/build");

    /* Not yet: no publish screen has been opened ANYWHERE, so this is a screen
       type the map has never seen and skipping it would lose a whole kind of
       page. Branch entered is not sufficient on its own. */
    expect(s.isSaturated("/org/alpha/publish")).toBe(false);
    s.markVisited("/org/alpha/publish");

    /* Now it is a fair skip: the branch has been entered and the shape has
       been seen. */
    expect(s.isSaturated("/org/bravo/publish")).toBe(true);
  });
});
