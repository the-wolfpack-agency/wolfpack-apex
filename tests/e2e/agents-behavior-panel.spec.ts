/**
 * Fleet behaviour panel reality check (/admin/agents).
 *
 * The last place to catch this before a client-facing conversation. Unit tests
 * prove the wording; this proves the panel actually renders on the deployed app
 * and does not throw in a real browser.
 *
 * The assertion that matters is the negative one: whatever state the panel is
 * in, it must never be the only thing on screen because it broke the roster.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Fleet behaviour panel reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/agents renders the behaviour panel without breaking the roster", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/agents`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    // 200, not merely "not 500": a 401 renders blank.
    expect(nav?.status(), "/admin/agents loads (not 401/blank)").toBe(200);

    // The roster is the page's reason to exist; the panel must not cost it.
    await expect(page.getByTestId("agents-fleet-overview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("fleet-behavior-panel")).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });

  test("never presents an unscored fleet as a clean bill of health", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/agents`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const panel = page.getByTestId("fleet-behavior-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Whichever state it settles in, the empty one has to say what it means.
    const empty = page.getByTestId("fleet-behavior-empty");
    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toContainText(/not a clean bill of health/i);
    }
  });
});
