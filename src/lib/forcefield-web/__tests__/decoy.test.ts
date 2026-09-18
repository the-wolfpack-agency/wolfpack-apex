/**
 * Page-trap generator - deterministic, invisible, and robots-disallowed, so the
 * classifier and the embedded page agree on the same trap path across deploys.
 */
import { makePageTrap, makePageTraps, TRAP_PATH_PREFIX } from "../decoy";
import { classifyWebRequest } from "../classify";

it("is deterministic: the same seed always yields the same trap path", () => {
  expect(makePageTrap("page-42").path).toBe(makePageTrap("page-42").path);
  expect(makePageTrap("page-42").path).not.toBe(makePageTrap("page-43").path);
  expect(makePageTrap("page-42").path.startsWith(`${TRAP_PATH_PREFIX}/`)).toBe(true);
});

it("the anchor is invisible, un-focusable, and marked nofollow", () => {
  const { html } = makePageTrap("seed");
  expect(html).toMatch(/aria-hidden="true"/);
  expect(html).toMatch(/tabindex="-1"/);
  expect(html).toMatch(/rel="nofollow"/);
  expect(html).toMatch(/left:-9999px/);
});

it("emits a robots.txt Disallow line for the trap path", () => {
  const t = makePageTrap("seed");
  expect(t.robotsDisallow).toBe(`Disallow: ${t.path}`);
});

it("a generated trap is caught by the classifier that registers it (end to end)", () => {
  const trap = makePageTrap("checkout-page");
  const v = classifyWebRequest(
    { path: trap.path, method: "GET", userAgent: "GreedyScraper/1" },
    { trapPaths: [trap.path], knownAgents: [] },
  );
  expect(v.class).toBe("trapped");
  expect(v.matchedTrapPath).toBe(trap.path);
});

it("makePageTraps de-duplicates by path", () => {
  const traps = makePageTraps(["a", "a", "b"]);
  const paths = traps.map((t) => t.path);
  expect(new Set(paths).size).toBe(paths.length);
  expect(traps.length).toBe(2);
});
