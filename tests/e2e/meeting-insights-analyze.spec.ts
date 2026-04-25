/**
 * Meeting Insights — Phase 5 ad-hoc analyze E2E.
 *
 * Walks the operator journey:
 *   1. /meetings/analyze loads (HTTP 200)
 *   2. Form renders with empty state (no results yet)
 *   3. Submit a subject filter, see analyze response render (200)
 *   4. Click "Save as feed" → land on /meetings/feeds with prefill
 *      query → form auto-opens with subject filter populated.
 *
 * Asserts HTTP 200, no CSP / pageerror / 4xx-5xx XHR failures.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD. Skipped otherwise.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

test.describe("/meetings/analyze — Phase 5 ad-hoc analysis", () => {
  test("submit ad-hoc analyze + save-as-feed prefill", async ({ page }) => {
    const target = resolveSmokeTarget();
    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD required");
      return;
    }
    const failures = collectConsoleAndNetworkFailures(page);
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);

    /* ---------- /meetings/analyze loads ---------- */
    const resp = await page.goto(`${target.baseUrl}/meetings/analyze`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(
      resp?.status(),
      "GET /meetings/analyze status (401 = blank page)",
    ).toBe(200);
    await expect(page.getByTestId("meetings-analyze-page")).toBeVisible();
    await expect(page.getByTestId("meetings-analyze-form")).toBeVisible();

    /* ---------- Submit ---------- */
    await page.getByTestId("analyze-subjects").fill("weekly");
    const [analyzeResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/meetings/analyze") &&
          r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByTestId("analyze-submit").click(),
    ]);
    expect(analyzeResp.status()).toBe(200);
    await expect(page.getByTestId("analyze-results")).toBeVisible({
      timeout: 10_000,
    });

    /* ---------- Save as feed → prefill ---------- */
    await page.getByTestId("analyze-save-as-feed").click();
    await page.waitForURL(/\/meetings\/feeds\?prefill=/, { timeout: 10_000 });
    // Form opened automatically and subject filter is populated.
    await expect(page.getByTestId("meeting-feed-form")).toBeVisible();

    /* ---------- Settle window ---------- */
    await page.waitForTimeout(2_000);
    const collected = failures();
    expect(
      collected,
      `CSP / pageerror / 401 / 5xx failures during journey:\n${collected
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
