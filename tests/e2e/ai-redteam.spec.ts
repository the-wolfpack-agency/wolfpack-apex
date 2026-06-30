/**
 * AI Red-Team assurance reality check (/admin/ai-redteam).
 *
 * The "assure" demo beat: the standing proof the gate blocks the known AI attack
 * classes. Proves the page is wired to its real API against a real DB and renders
 * cleanly in the browser. Read-only (it does not trigger a run).
 *
 * Sign in (skip if SMOKE creds absent), load /admin/ai-redteam, assert 200 +
 * not-blank ("AI Red-Team") + summary-or-empty render + zero CSP/network
 * failures. Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("AI Red-Team assurance reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/ai-redteam renders the assurance view cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-redteam`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ai-redteam loads (not 401/blank)").toBe(200);

    await expect(page.getByText("AI Red-Team", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const summary = page.getByTestId("ai-redteam-summary");
    const empty = page.getByTestId("ai-redteam-empty");
    await expect(summary.or(empty).first()).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
