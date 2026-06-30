/**
 * AI Surface Inventory — live repo-scan reality check (/admin/ai-surfaces).
 *
 * Proves, at the browser layer the jest suite cannot reach, that the live
 * repo-scan UI additions (the "Scan a public repo" URL input + button) render
 * and wire cleanly against the deployed app — a 200, not a 200-that-blanks.
 *
 * DELIBERATELY read-only: it asserts the scan controls render and accept input,
 * but NEVER clicks "Scan repo" — CI must not trigger a live external GitHub fetch
 * (rate limits, flakiness, side effects on the workspace inventory). The
 * supplied-source scan flow is covered by jest contract + UI tests; this spec is
 * purely the render/parity check.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips cleanly
 * when creds are missing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("AI Surface Inventory repo-scan reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/ai-surfaces renders the live repo-scan controls cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-surfaces`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ai-surfaces loads (not 401/blank)").toBe(200);

    // Page title rendered (not blank).
    await expect(page.getByText("AI Surface Inventory", { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The live repo-scan input + button mounted and accept a URL — but we do
    // NOT submit (no live external scan in CI).
    const urlInput = page.getByTestId("repo-scan-url");
    await expect(urlInput).toBeVisible({ timeout: 15_000 });
    await urlInput.fill("https://github.com/owner/repo");
    await expect(urlInput).toHaveValue("https://github.com/owner/repo");
    await expect(page.getByTestId("repo-scan-button")).toBeVisible();

    // No CSP/network failures while the page settled.
    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(
      failures,
      `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`,
    ).toEqual([]);
  });
});
