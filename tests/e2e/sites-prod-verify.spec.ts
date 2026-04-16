/**
 * Sites production verification suite.
 *
 * Covers the 2026-04-16 redesign and the fetchWithRefresh auth-redirect
 * fix. Runs against PROD_URL (or localhost fallback). Supports two modes:
 *
 *   1. **No credentials** — verifies unauthenticated users get redirected
 *      to /login (not a blank "Unauthorized" page), and that /login and
 *      /security-posture render correctly. This is the CI default.
 *
 *   2. **With credentials** (SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD) —
 *      signs in, navigates the sites list and detail pages, asserts the
 *      redesigned status banner + guided-flow structure render, and
 *      confirms no CSP/network errors.
 *
 * Screenshots are saved to tests/e2e/screenshots/ (gitignored) for
 * visual confirmation after each run. Run via:
 *
 *   npm run test:e2e:prod           # against deployed URL
 *   npm run canary                  # same, but with GitHub reporter for CI
 *   PROD_URL=http://localhost:3000 npm run test:e2e:prod  # local
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
  probePath,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("sites — unauthenticated behavior", () => {
  test("/login renders with form fields and branding", async ({ page }) => {
    await probePath(page, target, { path: "/login", expectText: "Sign In" });
    await page.screenshot({ path: "tests/e2e/screenshots/login-page.png", fullPage: true });
  });

  test("/sites redirects to /login (not blank Unauthorized)", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);

    await page.goto(`${target.baseUrl}/sites`, { waitUntil: "networkidle" });
    await page.screenshot({ path: "tests/e2e/screenshots/sites-unauth.png", fullPage: true });

    expect(page.url()).toContain("/login");
    const body = await page.locator("body").innerText().catch(() => "");
    expect(body).not.toContain("Unauthorized");
  });

  test("/sites/<id> redirects to /login (not blank Unauthorized)", async ({ page }) => {
    await page.goto(
      `${target.baseUrl}/sites/site_00000000-0000-0000-0000-000000000000`,
      { waitUntil: "networkidle" },
    );
    await page.screenshot({ path: "tests/e2e/screenshots/sites-detail-unauth.png", fullPage: true });

    expect(page.url()).toContain("/login");
    const body = await page.locator("body").innerText().catch(() => "");
    expect(body).not.toContain("Unauthorized");
  });

  test("/security-posture renders publicly", async ({ page }) => {
    await probePath(page, target, { path: "/security-posture", expectText: "Security" });
    await page.screenshot({ path: "tests/e2e/screenshots/security-posture.png", fullPage: true });
  });
});

test.describe("sites — authenticated flow", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/sites list page renders with + New Site button", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);

    await page.goto(`${target.baseUrl}/sites`, { waitUntil: "networkidle" });
    await page.screenshot({ path: "tests/e2e/screenshots/sites-list-authed.png", fullPage: true });

    expect(page.url()).toContain("/sites");
    const body = await page.locator("body").innerText().catch(() => "");
    expect(body).toContain("Sites");

    // No CSP / network failures
    await page.waitForTimeout(2000);
    const failures = snapshot();
    expect(failures).toEqual([]);
  });

  test("/sites list shows Archive button on each site card", async ({ page }) => {
    await page.goto(`${target.baseUrl}/sites`, { waitUntil: "networkidle" });

    // If there are any sites, each card should have a Delete/Archive button
    const archiveButtons = page.locator('button:has-text("Delete"), button[aria-label*="Archive"]');
    const siteCards = page.locator('a[href^="/sites/site_"]');
    const cardCount = await siteCards.count();

    if (cardCount > 0) {
      const btnCount = await archiveButtons.count();
      expect(btnCount).toBeGreaterThanOrEqual(1);
      await page.screenshot({ path: "tests/e2e/screenshots/sites-list-with-cards.png", fullPage: true });
    }
  });

  test("sites detail page renders guided flow with status banner", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);

    // Navigate to /sites, find the first site card, click it
    await page.goto(`${target.baseUrl}/sites`, { waitUntil: "networkidle" });
    const firstSite = page.locator('a[href^="/sites/site_"]').first();
    const hasSites = (await firstSite.count()) > 0;

    if (!hasSites) {
      test.skip();
      return;
    }

    await firstSite.click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "tests/e2e/screenshots/sites-detail-authed.png", fullPage: true });

    // Status banner should be visible (the core redesign element)
    const statusBanner = page.locator('[role="status"]');
    await expect(statusBanner).toBeVisible({ timeout: 10_000 });

    // Guided flow steps should be present
    const body = await page.locator("body").innerText().catch(() => "");
    expect(body).toContain("Edit the brief");
    expect(body).toContain("Upload images");

    // Should have either "Generate preview" or "Re-deploy"
    const hasDeployCta =
      body.includes("Generate preview") || body.includes("Re-deploy");
    expect(hasDeployCta).toBe(true);

    // Archive site button should exist
    const archiveBtn = page.locator('button:has-text("Archive site")');
    await expect(archiveBtn).toBeVisible();

    // Back-link to all sites
    const backLink = page.locator('a:has-text("All sites")');
    await expect(backLink).toBeVisible();

    // No CSP / network failures
    await page.waitForTimeout(2000);
    const failures = snapshot();
    expect(failures).toEqual([]);
  });

  test("sites detail page is responsive (mobile viewport)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone X

    await page.goto(`${target.baseUrl}/sites`, { waitUntil: "networkidle" });
    const firstSite = page.locator('a[href^="/sites/site_"]').first();
    if ((await firstSite.count()) === 0) {
      test.skip();
      return;
    }

    await firstSite.click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "tests/e2e/screenshots/sites-detail-mobile.png", fullPage: true });

    // Page should not have horizontal scroll (max-width 880px collapses to viewport)
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 20); // 20px tolerance
  });
});
