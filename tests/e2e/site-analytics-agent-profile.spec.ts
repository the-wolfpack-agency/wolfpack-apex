/**
 * Site Analytics agent-profile reality check (/admin/site-analytics).
 *
 * The last place to catch this before a client-facing conversation. Unit +
 * component tests prove the profile builder and the expand interaction; this
 * proves the panel actually renders and expands on the deployed app in a real
 * browser, and that opening a profile never throws or blanks the page.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips when
 * unavailable (like every smoke spec here). Data-tolerant: if there are no
 * journeys yet, it asserts the empty state rather than failing.
 */

import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Site Analytics agent profile reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/site-analytics loads and a journey expands into an agent profile", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/site-analytics`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    // 200, not merely "not 500": a 401 renders blank.
    expect(nav?.status(), "/admin/site-analytics loads (not 401/blank)").toBe(200);

    // The page's own surface must render.
    await expect(page.getByTestId("site-analytics-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("ff-journeys-list")).toBeVisible({ timeout: 15_000 });

    // If a journey exists, expanding it must reveal the profile; otherwise the
    // list must state its empty case rather than render nothing.
    const toggle = page.getByRole("button", { name: /view agent profile/i }).first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      const panel = page.locator('[data-testid^="ff-journey-profile-"]').first();
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(panel).toContainText(/why this verdict/i);
      await expect(panel).toContainText(/operator fingerprint/i);
      await expect(panel).toContainText(/does not establish a real-world identity/i);
    } else {
      await expect(page.getByTestId("ff-journeys-list")).toContainText(/no correlated agent journeys yet/i);
    }

    await page.waitForTimeout(1_500);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
