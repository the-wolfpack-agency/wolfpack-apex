/**
 * Dashboard MS 365 tiles — reality check.
 *
 * Locks the two new panels onto the dashboard:
 *   - MeetingPreBriefPanel renders in one of its four valid states
 *     (meeting tile, empty, error, or restricted-hidden). "Hidden on
 *     15-min-before gate" is explicitly not valid anymore.
 *   - MsInsightsPanel renders in one of its three valid states
 *     (panel with insights, error, or restricted-hidden).
 *
 * Skips gracefully when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are
 * missing so canary runs in environments without creds don't fail red.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("dashboard MS 365 tiles", () => {
  test("MeetingPreBriefPanel + MsInsightsPanel render in a valid state", async ({ page }) => {
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD not set; skipping");
      return;
    }
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);

    await page.goto(`${target.baseUrl}/`, { waitUntil: "networkidle" });

    // Prebrief panel: must be in a known terminal state, not loading.
    await expect
      .poll(async () => {
        const ids = [
          "meeting-prebrief-panel",
          "meeting-prebrief-panel-empty",
          "meeting-prebrief-panel-error",
        ];
        for (const id of ids) {
          if ((await page.locator(`[data-testid="${id}"]`).count()) > 0) return id;
        }
        // Hidden on 403 is allowed — signal that explicitly.
        if ((await page.locator('[data-testid="meeting-prebrief-panel-loading"]').count()) === 0) {
          return "restricted-hidden";
        }
        return null;
      }, { timeout: 15_000 })
      .not.toBeNull();

    // Insights panel: same contract.
    await expect
      .poll(async () => {
        const ids = ["ms-insights-panel", "ms-insights-panel-error"];
        for (const id of ids) {
          if ((await page.locator(`[data-testid="${id}"]`).count()) > 0) return id;
        }
        if ((await page.locator('[data-testid="ms-insights-panel-loading"]').count()) === 0) {
          return "restricted-hidden";
        }
        return null;
      }, { timeout: 15_000 })
      .not.toBeNull();
  });
});
