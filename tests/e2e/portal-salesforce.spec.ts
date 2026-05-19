/**
 * /portal/salesforce — E2E smoke against the deployed URL.
 *
 * Path:
 *   sign in → load /portal/salesforce → click into Contacts → search →
 *   drill into the first row → assert fields render.
 *
 * Cleanly skips when SMOKE_TEST_EMAIL/PASSWORD aren't set, matching the
 * pattern in every other reality-check spec. Workspaces that don't have
 * Salesforce connected ALSO skip cleanly — the page rendering the
 * "Connect Salesforce" CTA isn't a failure.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SPEC = "portal-salesforce";

test.describe("portal — salesforce mini-dashboard", () => {
  test("dashboard → contacts → drill-in renders fields", async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, `${SPEC}: SMOKE_TEST_EMAIL/PASSWORD not set`);
      return;
    }

    expect(await signInIfPossible(page, target)).toBe(true);

    await page.goto(`${target.baseUrl}/portal/salesforce`, { waitUntil: "domcontentloaded" });
    /* The page renders the title for both branches (configured + CTA),
       so it's a safe proof we landed on /portal/salesforce. */
    await expect(page.getByTestId("sf-portal-title")).toBeVisible({ timeout: 15_000 });

    /* If the workspace doesn't have Salesforce connected, render the
       CTA and stop — skipping is honest rather than asserting that an
       unconnected tenant has rows. */
    const cta = page.getByTestId("sf-portal-cta");
    if (await cta.isVisible().catch(() => false)) {
      test.skip(true, `${SPEC}: workspace not connected to Salesforce — skipping drill-in path`);
      return;
    }

    /* Click into Contacts via the quick-link. */
    await page.getByTestId("sf-link-contacts").click();
    await expect(page).toHaveURL(/\/portal\/salesforce\/contacts$/);
    await expect(page.getByTestId("sf-list-table-contacts")).toBeVisible({ timeout: 15_000 });

    /* Type a non-trivial search so the debounced fetch fires. The list
       remains usable for any 2+ char input — "a" matches everything by
       default; we use "a" so the test is robust against empty CRMs. */
    await page.getByTestId("sf-list-search-contacts").fill("a");
    /* Give the 300ms debounce time + a single fetch. */
    await page.waitForTimeout(700);

    /* Click the first contact name (primary column link). */
    const firstRow = page
      .getByTestId("sf-list-table-contacts")
      .locator("tbody tr")
      .first();
    /* If the table has only the "no rows match" placeholder, treat
       this as a clean skip — the surface renders fine, just no data. */
    const hasLink = await firstRow.locator("a").first().isVisible().catch(() => false);
    if (!hasLink) {
      test.skip(true, `${SPEC}: no contacts to drill into — skipping`);
      return;
    }
    await firstRow.locator("a").first().click();

    /* Drill-in page renders the title + at least one field row. */
    await expect(page.getByTestId("sf-record-title")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sf-record-fields")).toBeVisible();
  });
});
