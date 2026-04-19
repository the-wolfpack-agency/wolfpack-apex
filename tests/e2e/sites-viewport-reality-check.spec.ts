/**
 * Sites — responsive viewport toggle reality check.
 *
 * Stream P1 (Path C Phase 1). Designers can flip the preview iframe
 * between Mobile (390px), Tablet (834px), and Desktop (1280px) without
 * leaving /sites/[id]/edit. This spec is the browser-level proof that:
 *
 *   1. The toggle is visible in the edit page's right-pane header.
 *   2. Clicking Mobile/Tablet/Desktop changes the ACTUAL rendered
 *      iframe width (client width ≈ target ±10px for mobile/tablet,
 *      ≥1200px for desktop).
 *   3. The URL query parameter `?viewport=` reflects the selection so
 *      refresh + deep-link survive.
 *   4. Each state produces a screenshot for human review.
 *
 * Gate conditions (skip cleanly, not fail):
 *   - SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD must be set (auth flow).
 *   - SITES_SMOKE_PROJECT_ID must point at a deployed site's id.
 *
 * Runs against PROD_URL when set, localhost otherwise.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SMOKE_PROJECT_ID = process.env.SITES_SMOKE_PROJECT_ID ?? "";
const SPEC_NAME = "sites-viewport-reality-check";

const VIEWPORT_WIDTHS = {
  mobile: 390,
  tablet: 834,
  desktop: 1280,
} as const;

test.describe("sites — responsive viewport toggle reality check", () => {
  test("Mobile/Tablet/Desktop buttons resize the preview iframe + update URL", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    if (!target.email || !target.password) {
      result = "skip";
      note = "SMOKE_TEST_EMAIL/PASSWORD not set";
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
      test.skip(true, note);
      return;
    }
    if (!SMOKE_PROJECT_ID) {
      result = "skip";
      note = "SITES_SMOKE_PROJECT_ID not set";
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
      test.skip(true, note);
      return;
    }

    try {
      expect(await signInIfPossible(page, target)).toBe(true);

      // Give the Instinct UI a viewport big enough that the toolbar is
      // NOT collapsed to the mobile <select> (triggered < 768px). The
      // toggle tests the device simulation — not Instinct's own
      // responsive behavior, which has separate coverage.
      await page.setViewportSize({ width: 1440, height: 900 });

      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });

      // Wait for the preview iframe + toggle to mount.
      const iframe = page.locator('[data-testid="edit-preview-iframe"]');
      await expect(iframe).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="viewport-toggle"]')).toBeVisible();

      // ---- 1. Mobile ----
      await page.locator('[data-testid="viewport-toggle-mobile"]').click();
      // Let the 200ms width transition settle + one extra frame.
      await page.waitForTimeout(300);
      const mobileBox = await iframe.boundingBox();
      expect(mobileBox, "iframe must be in the DOM after Mobile click").not.toBeNull();
      expect(
        Math.abs((mobileBox?.width ?? 0) - VIEWPORT_WIDTHS.mobile),
        `Mobile iframe width ${mobileBox?.width} not within ±10px of ${VIEWPORT_WIDTHS.mobile}`,
      ).toBeLessThanOrEqual(10);
      expect(page.url()).toContain("viewport=mobile");
      await page.screenshot({
        path: "tests/e2e/screenshots/viewport-mobile.png",
        fullPage: true,
      });

      // ---- 2. Tablet ----
      await page.locator('[data-testid="viewport-toggle-tablet"]').click();
      await page.waitForTimeout(300);
      const tabletBox = await iframe.boundingBox();
      expect(
        Math.abs((tabletBox?.width ?? 0) - VIEWPORT_WIDTHS.tablet),
        `Tablet iframe width ${tabletBox?.width} not within ±10px of ${VIEWPORT_WIDTHS.tablet}`,
      ).toBeLessThanOrEqual(10);
      expect(page.url()).toContain("viewport=tablet");
      await page.screenshot({
        path: "tests/e2e/screenshots/viewport-tablet.png",
        fullPage: true,
      });

      // ---- 3. Desktop ----
      await page.locator('[data-testid="viewport-toggle-desktop"]').click();
      await page.waitForTimeout(300);
      const desktopBox = await iframe.boundingBox();
      expect(
        desktopBox?.width ?? 0,
        `Desktop iframe width ${desktopBox?.width} must be ≥ 1200px`,
      ).toBeGreaterThanOrEqual(1200);
      expect(page.url()).toContain("viewport=desktop");
      await page.screenshot({
        path: "tests/e2e/screenshots/viewport-desktop.png",
        fullPage: true,
      });

      // ---- 4. Deep-link survives refresh ----
      // Navigate directly to ?viewport=mobile and verify the toggle
      // picks it up. This is the designer-sharing-a-link use case.
      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit?viewport=mobile`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator('[data-testid="edit-preview-iframe"]')).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(300);
      const reloadedMobileBox = await page
        .locator('[data-testid="edit-preview-iframe"]')
        .boundingBox();
      expect(
        Math.abs((reloadedMobileBox?.width ?? 0) - VIEWPORT_WIDTHS.mobile),
        `Deep-link ?viewport=mobile width ${reloadedMobileBox?.width} not within ±10px of ${VIEWPORT_WIDTHS.mobile}`,
      ).toBeLessThanOrEqual(10);
      await expect(page.locator('[data-testid="viewport-toggle-mobile"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } catch (err) {
      result = "fail";
      note = (err as Error).message?.slice(0, 240);
      throw err;
    } finally {
      await recordRealityCheckRun(
        request,
        target,
        await authToken(page).catch(() => ""),
        {
          spec: SPEC_NAME,
          result,
          duration_ms: Date.now() - start,
          note,
        },
      );
    }
  });
});
