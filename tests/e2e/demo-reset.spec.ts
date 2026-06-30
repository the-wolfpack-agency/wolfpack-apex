/**
 * Demo Reset reality check (/admin/demo).
 *
 * The operator's pre-demo button: one click restores a populated governance
 * state across all five beats. This proves the page is wired to its real API
 * against a real DB and renders cleanly in the browser. Read-only render check
 * (it does NOT click Reset, to avoid mutating the live workspace from CI).
 *
 * Sign in (skip if SMOKE creds absent), load /admin/demo, assert 200 +
 * not-blank ("Demo Reset") + the pre-run empty state renders + zero CSP/network
 * failures. Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Demo Reset reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/demo renders the demo-reset control cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/demo`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/demo loads (not 401/blank)").toBe(200);

    await expect(page.getByText("Demo Reset", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const run = page.getByTestId("demo-reset-run");
    const empty = page.getByTestId("demo-reset-empty");
    await expect(run.or(empty).first()).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
