/**
 * Compliance evidence reality check (/admin/compliance).
 *
 * The "comply" demo beat: framework coverage generated from live OGIAM controls,
 * not a binder. Proves the page is wired to its real API against a real DB and
 * renders cleanly in the browser. Read-only (it loads history; it does not
 * generate a report).
 *
 * Sign in (skip if SMOKE creds absent), load /admin/compliance, assert 200 +
 * not-blank ("Compliance") + history-or-empty render + zero CSP/network
 * failures. Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Compliance evidence reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/compliance renders the evidence view cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/compliance`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/compliance loads (not 401/blank)").toBe(200);

    await expect(page.getByText("Compliance", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const summary = page.getByTestId("compliance-summary");
    const empty = page.getByTestId("compliance-empty");
    await expect(summary.or(empty).first()).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
