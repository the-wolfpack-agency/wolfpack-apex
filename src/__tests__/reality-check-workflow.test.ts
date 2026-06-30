/**
 * Guard for the E2E Reality Check workflow (.github/workflows/e2e-reality-check.yml).
 *
 * The reality-check is a merge gate; a silent drift (a renamed spec that no
 * longer exists, the hard gates falling out, or the slow soft specs leaking back
 * onto the PR critical path) would quietly weaken or slow it. This asserts the
 * invariants of the speed/reliability restructure so they can't regress unnoticed.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WF = path.join(REPO_ROOT, ".github/workflows/e2e-reality-check.yml");
const yaml = fs.readFileSync(WF, "utf8");

/** The hard gates that must run on every PR + push. */
const HARD_GATES = ["tests/e2e/sites-preview-reality-check.spec.ts", "tests/e2e/dashboard-quick-actions.spec.ts"];

function referencedSpecs(): string[] {
  return [...new Set(yaml.match(/tests\/e2e\/[a-z0-9-]+\.spec\.ts/g) ?? [])];
}

test("every spec the workflow references actually exists (no silently-dropped spec)", () => {
  const missing = referencedSpecs().filter((s) => !fs.existsSync(path.join(REPO_ROOT, s)));
  expect(missing).toEqual([]);
});

test("both hard gates are present", () => {
  for (const g of HARD_GATES) expect(yaml).toContain(g);
});

test("targets the deployed app: skips loudly when PROD_URL is unset (no local dev-server fallback in CI)", () => {
  expect(yaml).toMatch(/PROD_URL secret not set/i);
  expect(yaml).toMatch(/configured=false/);
  // Every spec-running step is gated on the PROD_URL check.
  expect(yaml).toMatch(/steps\.cfg\.outputs\.configured == 'true'/);
});

test("soft specs run on push-to-main ONLY (kept off the PR critical path)", () => {
  // The soft-specs step gate combines the config flag with a push-only event check.
  expect(yaml).toMatch(/configured == 'true' && github\.event_name == 'push'/);
});

test("the Playwright browser is cached (the install only runs on a version bump)", () => {
  expect(yaml).toMatch(/~\/\.cache\/ms-playwright/);
  expect(yaml).toMatch(/cache-hit/);
});

test("the hard gates run in a single parallel invocation", () => {
  // One playwright invocation with --workers=2 carrying both gate specs.
  const gatesStep = yaml.slice(yaml.indexOf("Reality-check gates"));
  expect(gatesStep).toMatch(/--workers=2/);
  for (const g of HARD_GATES) expect(gatesStep.slice(0, gatesStep.indexOf("Reality-check soft"))).toContain(g);
});
