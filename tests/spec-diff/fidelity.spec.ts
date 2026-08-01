/**
 * Fixture in, verdict out: does the tool actually catch a build that does not
 * match its prototype?
 *
 * WHY THIS EXISTS
 *
 * Everything else that tests this feature stops at a boundary where the numbers
 * are invented by the test. compare.ts is exercised with hand-written SpecItem
 * objects, run.ts with a fake browser that returns hand-written items, and the
 * acceptance evaluator with hand-written summaries. Each of those is a good
 * test of its own logic and NONE of them proves the thing the product claims:
 * point this at a prototype and a build, and it tells you the truth.
 *
 * The gap was concrete. probes.ts — collectItems and collectFont, the only code
 * that reads a real DOM and produces the measurements everything downstream
 * reasons about — had no test at all. It cannot have one in jsdom either: jsdom
 * has no layout engine, so every box is 0x0 and every assertion about a 66px
 * header would pass or fail for reasons unrelated to the page.
 *
 * So this runs the REAL chain in a REAL browser against files on disk:
 *
 *   fixture .html -> collectItems/collectFont -> compareItems -> summarize
 *                 -> evaluateAcceptance -> verdict
 *
 * No dev server, no database, no auth (same posture as the QR decode guard).
 * The fixtures are readable, reviewable artifacts: a prototype and five builds,
 * each documenting the defect it encodes in a comment at the top of the file.
 */
import { test, expect, type Browser } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { runSpecDiff, type SpecDiffBrowser } from "../../src/lib/spec-diff/run";
import { evaluateAcceptance } from "../../src/lib/site-acceptance/evaluate";
import { parseCriteria } from "../../src/lib/site-acceptance/criteria";

const fixture = (name: string) => pathToFileURL(join(__dirname, "fixtures", name)).href;

/** One viewport: the fixtures are fixed-width, so a second adds cost and no signal. */
const VIEWPORTS = [{ width: 1200, height: 900 }];

/** Playwright's Browser structurally satisfies the engine's browser port. */
const asPort = (browser: Browser): SpecDiffBrowser => browser as unknown as SpecDiffBrowser;

async function compare(browser: Browser, build: string) {
  return runSpecDiff({ specUrl: fixture("prototype.html"), targetUrl: fixture(build), viewports: VIEWPORTS }, asPort(browser));
}

/** The verdict an operator would see for this build, via the real evaluator. */
function verdictFor(run: Awaited<ReturnType<typeof compare>>) {
  return evaluateAcceptance(parseCriteria({ prototypeUrl: "https://prototype.test" }), {
    deployedUrl: "https://build.test",
    // Routes are proven separately; this spec is about the layout + font checks.
    routes: [{ path: "/", status: 200, body: "ok" }],
    layout: { summary: run.summary },
  });
}
const check = (v: ReturnType<typeof verdictFor>, id: string) => v.checks.find((c) => c.id === id)!;

test.describe("spec-diff fidelity (real browser, real fixtures)", () => {
  test("a faithful conversion reports clean, even though its markup is different", async ({ browser }) => {
    // The build uses semantic tags and different class names throughout. If the
    // tool reported structure instead of design, this would fail.
    const run = await compare(browser, "build-faithful.html");

    expect(run.errors, `measure errors: ${JSON.stringify(run.errors)}`).toEqual([]);
    // Non-zero is the assertion that matters: zero matches would make "no
    // differences" meaningless, and it is how a broken probe looks like a pass.
    expect(run.summary.matchedElements).toBeGreaterThan(4);
    expect(run.summary.totalDiffs, JSON.stringify(run.results[0]?.diffs)).toBe(0);
    expect(run.summary.fontMismatch).toBe(false);
    expect(run.summary.clean).toBe(true);

    const v = verdictFor(run);
    expect(v.accepted).toBe(true);
    expect(check(v, "layout").status).toBe("passed");
  });

  test("the drifted build is caught, and named field by field", async ({ browser }) => {
    const run = await compare(browser, "build-drifted.html");
    const diffs = run.results[0].diffs;
    const field = (text: RegExp, name: string) =>
      diffs.find((d) => text.test(d.text))?.fields.find((f) => f.field === name);

    expect(run.summary.matchedElements).toBeGreaterThan(4);
    expect(run.summary.totalDiffs).toBeGreaterThan(0);

    // Each of these is a real defect from the conversion this tooling followed.
    // Asserting the DELTA, not merely "something differs", is what makes the
    // report actionable: it tells you which way and by how much.
    expect(field(/Dealer Dashboard/, "height")?.delta).toBeCloseTo(6, 0);
    expect(field(/A Weekend with Porsche/, "top")?.delta).toBeCloseTo(6, 0);
    expect(field(/A Weekend with Porsche/, "fontSize")?.delta).toBeCloseTo(-19, 0);
    expect(field(/Existing Guests/, "width")?.delta).toBeCloseTo(-22, 0);

    const v = verdictFor(run);
    expect(v.accepted).toBe(false);
    expect(check(v, "layout").status).toBe("failed");
    expect(check(v, "layout").detail).toMatch(/outside the .*px tolerance/);
  });

  test("the tolerance is load-bearing: a few pixels report strictly and pass when allowed", async ({ browser }) => {
    // Without this, a clean result on the faithful build could equally be a tool
    // that never fires. The same fixture has to change verdict with the setting.
    const strict = await compare(browser, "build-nudged.html");
    expect(strict.summary.totalDiffs).toBeGreaterThan(0);

    const lenient = await runSpecDiff(
      { specUrl: fixture("prototype.html"), targetUrl: fixture("build-nudged.html"), viewports: VIEWPORTS, tolerancePx: 10 },
      asPort(browser),
    );
    expect(lenient.summary.matchedElements).toBe(strict.summary.matchedElements);
    expect(lenient.summary.totalDiffs).toBe(0);
  });

  test("a different typeface is caught even when every box is the right size", async ({ browser }) => {
    const run = await compare(browser, "build-wrong-font.html");

    // Declared names lie; glyph advance does not. This build claims nothing
    // unusual and lays out identically, so geometry alone would call it clean.
    expect(run.summary.fontMismatch).toBe(true);
    expect(run.summary.clean).toBe(false);

    const v = verdictFor(run);
    expect(v.accepted).toBe(false);
    expect(check(v, "font").status).toBe("failed");
    // A real failure, not an absence of measurement.
    expect(v.degraded).toBe(false);
  });

  test("a build with nothing in common is UNMEASURED, never a perfect match", async ({ browser }) => {
    // The failure this whole layer exists to prevent: zero comparisons produce
    // zero differences, which reads as flawless unless something refuses it.
    const run = await compare(browser, "build-unrelated.html");

    expect(run.summary.matchedElements).toBe(0);
    expect(run.summary.totalDiffs).toBe(0);
    expect(run.summary.totalMissing).toBeGreaterThan(0);

    const v = verdictFor(run);
    expect(check(v, "layout").status).toBe("unmeasured");
    expect(v.accepted).toBe(false);
    expect(v.degraded).toBe(true);
    expect(v.summary).toMatch(/not a pass/);
  });

  test("the report names the worst offenders, so a fix has somewhere to start", async ({ browser }) => {
    const run = await compare(browser, "build-drifted.html");
    expect(run.summary.worstOffenders.length).toBeGreaterThan(0);
    // Ordered by magnitude: the 63px hero outranks the 6px header.
    const deltas = run.summary.worstOffenders.map((o) => o.delta);
    expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
    expect(deltas[0]).toBeGreaterThan(20);
  });
});
