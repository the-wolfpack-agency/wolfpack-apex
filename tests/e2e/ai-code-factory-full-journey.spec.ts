/**
 * Factory FULL JOURNEY (LIVE) - prompt -> gated code -> real PR -> PR link in the
 * UI -> human-in-the-loop. Drives the DEPLOYED factory at /admin/ai-code against
 * the THROWAWAY repo wolfpack-cayenne-e4 (never apex), so a real PR can be opened
 * end to end with zero blast radius on production.
 *
 * It takes the journey a client runs: sign in, point the factory at a target
 * repo, describe a complete small feature, watch it gate the authored code, give
 * consent, approve, and SEE the real pull-request link render in the UI. It stops
 * at the PR link: merging + deploying is the human's step (the factory never
 * merges), which is the governance point - not something a test automates away.
 *
 * Data-tolerant, so it reports reality instead of hanging:
 *   - gate held the change    -> asserts the honest needs-human handoff, no PR.
 *   - PR opened               -> asserts the link points at a real cayenne PR.
 *   - tier-2 validation hold  -> asserts the validating note (PR opens only once
 *                                the repo's own gate is green).
 *   - no cayenne token/App    -> asserts the honest compare-link/connect-github
 *                                state (the pushed work is never lost).
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips locally
 * when unset, FAILS LOUDLY in CI (never skip-green and hide that the live journey
 * never ran).
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const CAYENNE = "the-wolfpack-agency/wolfpack-cayenne-e4";

/** Sign in and open the factory; returns the console/network-failure snapshot. */
async function openFactory(page: Page): Promise<() => { kind: string; detail: string }[]> {
  const snapshot = collectConsoleAndNetworkFailures(page);
  const signedIn = await signInIfPossible(page, target);
  if (!signedIn) {
    if (process.env.CI === "true") {
      throw new Error("CI misconfiguration: the factory full-journey dogfood needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
    }
    test.skip();
  }
  const nav = await page.goto(`${target.baseUrl}/admin/ai-code`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(nav?.status(), "/admin/ai-code loads (not 401/blank)").toBe(200);
  await expect(page.getByTestId("ai-code-page"), "the factory shell mounts").toBeVisible({ timeout: 15_000 });
  return snapshot;
}

test.describe("Factory full journey (cayenne-e4)", () => {
  test.setTimeout(200_000);

  test("an unauthenticated visit redirects to /login (never a blank admin page)", async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${target.baseUrl}/admin/ai-code`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/login");
    } finally {
      await ctx.close();
    }
  });

  test("prompt -> gated code -> real PR link on the throwaway repo (human merges)", async ({ page }) => {
    const snapshot = await openFactory(page);

    // Point the factory at the throwaway repo BEFORE generating (the repo is
    // captured into the pipeline request and carried through to the PR open).
    await page.getByTestId("repo-input").fill(CAYENNE);

    const pipelineResp = page.waitForResponse(
      (r) => r.url().includes("/api/admin/ai-code/pipeline") && r.request().method() === "POST",
      { timeout: 175_000 },
    );
    await page.getByLabel("Prompt").fill(
      "Create a new file src/lib/greet.ts exporting `export function greet(name: string): string` that trims the name, " +
        "defaults an empty name to \"there\", and returns `Hello, ${name}!`. Add a co-located test src/lib/greet.test.ts " +
        "covering a normal name, a whitespace-padded name, and the empty default.",
    );
    await page.getByRole("button", { name: /generate & gate/i }).click();

    const resp = await pipelineResp;
    expect(resp.status(), "the pipeline responds 200-class (never 500/blank)").toBeLessThan(400);
    const body = await resp.json().catch(() => ({}));
    const run = body.run ?? body;
    const model = String((body.executor ?? run.executor)?.author ?? "");
    await expect(
      page.getByTestId("generated-code").or(page.getByTestId("handoff-status")).first(),
      "the UI renders a terminal result, not a spinner",
    ).toBeVisible({ timeout: 30_000 });
    console.log(`[dogfood:journey] repo=${CAYENNE} status=${run.status} model=${model}`);

    // The gate holding the change IS a valid terminal (human-in-the-loop by
    // design): assert the honest handoff and stop - no PR.
    if (run.status !== "ready_for_pr") {
      await expect(page.getByTestId("handoff-status")).toContainText(/needs human|withheld|did not allow|blocked/i);
      console.log("[dogfood:journey] gate held the change -> no PR (human-in-the-loop by design)");
      return;
    }

    // Human-in-the-loop: consent gates the approve button, then approve opens a
    // REAL PR on the throwaway repo.
    await expect(page.getByTestId("approve-consent"), "the consent control renders").toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("approve-open-pr"), "approve is disabled before consent").toBeDisabled();
    await page.getByTestId("approve-consent").check();
    await expect(page.getByTestId("approve-open-pr"), "approve enables after consent").toBeEnabled();
    await page.getByTestId("approve-open-pr").click();

    // Wait for ANY terminal approval outcome - never a hang.
    const prLink = page.getByTestId("pr-link");
    const compare = page.getByTestId("compare-link");
    const connect = page.getByTestId("connect-github");
    const validating = page.getByTestId("prepr-validation");
    await expect(
      prLink.or(compare).or(connect).or(validating).first(),
      "approve resolves to a PR link, an honest no-token state, or a tier-2 validating hold",
    ).toBeVisible({ timeout: 60_000 });

    if ((await prLink.count()) > 0) {
      const href = await prLink.getAttribute("href");
      expect(href, "the PR link points at a real cayenne-e4 pull request").toMatch(
        /github\.com\/the-wolfpack-agency\/wolfpack-cayenne-e4\/pull\/\d+/,
      );
      console.log(`[dogfood:journey] PR OPENED: ${href} -> a human reviews via this link and merges (the factory never merges)`);
      // The build + deploy surface renders for the PR branch (observational:
      // cayenne-e4's deploy is known to be infra-failing, unrelated to the change).
      await expect(page.getByTestId("pipeline-refresh"), "the build+deploy surface renders for the PR branch").toBeVisible({ timeout: 10_000 });
    } else if ((await validating.count()) > 0) {
      console.log("[dogfood:journey] tier-2 pre-PR validation HOLDING -> the PR opens only after the repo's own gate is green");
    } else {
      console.log("[dogfood:journey] honest no-PR state (no cayenne token/App): compare-link or connect-github shown - the pushed work is not lost");
    }

    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
