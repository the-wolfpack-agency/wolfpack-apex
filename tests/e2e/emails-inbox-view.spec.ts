/**
 * /emails inbox view — reality check.
 *
 * Locks the new inbox surface onto /emails:
 *   - Page reaches a terminal state (rows | empty | error), not infinite
 *     loading.
 *   - "New email" CTA exists and toggles the composer drawer.
 *   - Filter buttons (All / Unread) render.
 *   - HTTP 200 (not 401) when authenticated — assert this explicitly so
 *     blank pages caused by 401 redirects are caught.
 *
 * Skips gracefully when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are not
 * set so the workflow doesn't fail in environments without creds.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("emails inbox view", () => {
  test("inbox panel renders with filter + New email button", async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);

    const response = await page.goto(`${target.baseUrl}/emails`, { waitUntil: "networkidle" });
    // 200 — not just "not 500". A 401 here is the blank-dashboard bug pattern.
    expect(response?.status()).toBe(200);

    // Inbox rail renders.
    await expect(page.getByTestId("inbox-panel")).toBeVisible({ timeout: 10_000 });

    // Filter buttons render.
    await expect(page.getByTestId("inbox-filter-all")).toBeVisible();
    await expect(page.getByTestId("inbox-filter-unread")).toBeVisible();

    // New email CTA wires the composer.
    const newBtn = page.getByTestId("inbox-new-email");
    await expect(newBtn).toBeVisible();
    await newBtn.click();

    // The composer surface stays in the DOM (desktop layout) and the
    // To: input is reachable.
    await expect(page.getByLabel(/^To email input$/i)).toBeVisible({ timeout: 5_000 });

    // Inbox reaches a terminal state.
    await expect
      .poll(async () => {
        const ids = ["inbox-list", "inbox-empty", "inbox-error"];
        for (const id of ids) {
          if ((await page.getByTestId(id).count()) > 0) return id;
        }
        return null;
      }, { timeout: 15_000 })
      .not.toBeNull();
  });
});
