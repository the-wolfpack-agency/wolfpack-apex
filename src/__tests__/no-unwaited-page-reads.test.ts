/**
 * No end-to-end test may read a page's text before the page can have rendered.
 *
 * WHY THIS EXISTS
 *
 * `probePath` navigated with waitUntil "domcontentloaded" and then read
 * `body.innerText()` on the next line. At that instant every authenticated
 * route in this app shows exactly one thing: "Loading Instinct…". So the
 * assertion was about the loading screen.
 *
 * Two of the smoke's ten probes expected the fragment "Instinct", which the
 * splash contains, and therefore could not fail. The first probe that asked
 * for something else, /tasks, failed. Verify stayed red on main from
 * 2026-06-28 to 2026-08-24, fifty-odd runs, while production rendered the page
 * correctly the whole time.
 *
 * That was not one mistake. Nine other specs had copied the same two lines,
 * and the reality check was swallowing several of their failures behind
 * continue-on-error. Fixing the one that was visible would have left the rest.
 *
 * So this is the check that fails if it comes back. `expectRendered` in
 * tests/e2e/helpers/smoke-helpers.ts is the one implementation: it waits for
 * the splash to be absent AND the expected text to be present, together,
 * because before React mounts neither is true and "splash is gone" alone is
 * satisfied by a page showing nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E_DIR = join(__dirname, "..", "..", "tests", "e2e");

/** Anything that makes the following read a waited one. */
const WAITS =
  /waitFor|toBeVisible|toContainText|toHaveText|toHaveCount|expect\.poll|toPass|waitForTimeout|waitForSelector|waitForLoadState|waitForURL|waitForResponse|waitForFunction|probePath|expectRendered|toBeEnabled|networkidle/;
/** Reading the rendered text of the page. */
const READ = /\.(innerText|textContent)\(\)/;
/** Something that starts a render: a navigation, or an interaction causing one. */
const NAV = /page\.goto\(|\.click\(\)|\.press\(/;
/** How far back a read is considered "right after" the navigation. */
const WINDOW = 12;

function specFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(E2E_DIR);
  return out;
}

function unwaitedReads(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!READ.test(lines[i])) continue;
    for (let j = i - 1; j >= Math.max(0, i - WINDOW); j--) {
      if (WAITS.test(lines[j])) break;
      if (NAV.test(lines[j])) {
        hits.push(i + 1);
        break;
      }
    }
  }
  return hits;
}

describe("no e2e spec reads a page before it can have rendered", () => {
  it("finds the specs", () => {
    // If the walk silently returns nothing this file asserts nothing, which is
    // the exact failure it exists to prevent.
    expect(specFiles().length).toBeGreaterThan(10);
  });

  it("detects the shape it is looking for", () => {
    // The detector itself is tested, so a regex that stops matching cannot
    // quietly turn this into a check that always passes.
    const bad = [
      'await page.goto(url, { waitUntil: "domcontentloaded" });',
      'const t = await page.locator("body").innerText();',
    ].join("\n");
    const good = [
      'await page.goto(url, { waitUntil: "domcontentloaded" });',
      'await expectRendered(page, "/x", ["y"]);',
      'const t = await page.locator("body").innerText();',
    ].join("\n");
    expect(unwaitedReads(bad)).toEqual([2]);
    expect(unwaitedReads(good)).toEqual([]);
  });

  it.each(specFiles())("%s", (file) => {
    const hits = unwaitedReads(readFileSync(file, "utf8"));
    if (hits.length > 0) {
      throw new Error(
        `${file} reads the page text on line(s) ${hits.join(", ")} right after a ` +
          `navigation, with nothing waiting for the page in between. At that moment ` +
          `an authenticated route shows "Loading Instinct…" and nothing else, so the ` +
          `assertion is about the loading screen. Use expectRendered() from ` +
          `tests/e2e/helpers/smoke-helpers.ts, which waits for the splash to be gone ` +
          `and the text to be present together.`,
      );
    }
  });
});
