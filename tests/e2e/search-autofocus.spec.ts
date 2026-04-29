/**
 * /search — autofocus the search input on mount.
 *
 * Locks in PR #26: the input element with `autoFocus` actually wins
 * focus on real browser mount. jsdom does not honor `autoFocus` the
 * same way a real layout pass does, so this is a real-browser-only
 * regression guard.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function settle(page: import("@playwright/test").Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);
}

test.describe("search autofocus (real browser)", () => {
  test.beforeEach(async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);
  });

  test("search input is focused on /search mount", async ({ page }) => {
    const response = await page.goto(`${target.baseUrl}/search`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    await settle(page);

    const input = page.getByTestId("search-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toBeFocused();

    // Sanity: the focused element is an <input type="search">.
    const tag = await input.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).toBe("input");
    const type = await input.getAttribute("type");
    expect(type).toBe("search");
  });
});
