/**
 * Deployment release-gate reality check (/admin/deployment).
 *
 * The operator's pre-deploy surface: what is blocking production + the
 * recommended approval order so changes merge in a conflict-free sequence. This
 * proves the page renders cleanly in the browser against the real API. Read-only
 * (it does NOT promote anything from CI).
 *
 * Sign in (skip if SMOKE creds absent), load /admin/deployment, assert 200 +
 * not-blank + the release-gate section renders + zero CSP/network failures.
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Deployment release-gate reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/deployment renders the release gate cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/deployment`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/deployment loads (not 401/blank)").toBe(200);

    await expect(page.getByText("Deployment readiness", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    // The release-gate section mounts after the auth check; it renders whether or
    // not anything is blocking (empty state, rows, or an honest-degrade banner).
    await expect(page.getByTestId("release-gate-section")).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
