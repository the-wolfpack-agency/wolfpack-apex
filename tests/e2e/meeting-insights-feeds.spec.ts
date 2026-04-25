/**
 * Meeting Insights — feeds CRUD + run-now E2E.
 *
 * Walks the operator journey:
 *   1. /meetings/feeds index loads (empty or list — both are 200)
 *   2. Open the create form, submit a feed, see it appear in the list
 *   3. Click the new row → /meetings/feeds/[slug] detail loads
 *   4. Click "Run now" → standard polling banner appears
 *   5. Edit the feed → save → name updates
 *
 * Every step asserts HTTP 200 (NOT "not 500"; 401 = blank page) and
 * zero CSP / pageerror / 4xx-5xx XHR failures during a settle window.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD: skipped when creds
 * are missing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

test.describe("/meetings/feeds — meeting-insights flow", () => {
  test("create + view + run + edit a feed without auth or CSP errors", async ({
    page,
  }) => {
    const target = resolveSmokeTarget();

    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD required");
      return;
    }

    const failures = collectConsoleAndNetworkFailures(page);

    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in attempt must complete").toBe(true);

    /* ---------- /meetings/feeds index ---------- */
    const indexResp = await page.goto(`${target.baseUrl}/meetings/feeds`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(
      indexResp?.status(),
      "GET /meetings/feeds status (401 = blank page; we want 200)",
    ).toBe(200);

    await expect(page.getByRole("heading", { name: /Meeting Insights/i })).toBeVisible({
      timeout: 10_000,
    });

    /* ---------- Open create form + submit ---------- */
    await page.getByTestId("meeting-feed-new").click();
    await expect(page.getByTestId("meeting-feed-form")).toBeVisible();

    const uniqueSuffix = Date.now().toString(36);
    const feedName = `E2E Feed ${uniqueSuffix}`;
    await page.getByLabel(/^Name$/i).fill(feedName);
    await page.getByLabel(/Sender substrings/i).fill("@example.com");
    await page.getByLabel(/Subject substrings/i).fill("Stand-up");

    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/meetings/feeds") &&
          r.request().method() === "POST",
        { timeout: 15_000 },
      ),
      page.getByTestId("meeting-feed-form-submit").click(),
    ]);
    expect(
      createResp.status(),
      "POST /api/meetings/feeds created the feed",
    ).toBe(201);

    /* ---------- New row visible in list ---------- */
    await expect(page.getByText(feedName)).toBeVisible({ timeout: 10_000 });

    /* ---------- Click into detail page ---------- */
    await page.getByText(feedName).first().click();
    await page.waitForURL(/\/meetings\/feeds\/e2e-feed-/i, { timeout: 10_000 });
    await expect(page.getByTestId("meeting-feed-name")).toContainText(feedName);

    /* ---------- Run now ---------- */
    await page.getByTestId("meeting-feed-poll-now").click();
    await expect(page.getByTestId("meeting-feed-poll-result")).toBeVisible({
      timeout: 15_000,
    });

    /* ---------- Edit + save ---------- */
    await page.getByTestId("meeting-feed-edit-toggle").click();
    await expect(page.getByTestId("meeting-feed-edit-form")).toBeVisible();
    const renamed = `${feedName} (renamed)`;
    await page.getByLabel(/^Name$/i).fill(renamed);
    const [updateResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/meetings\/feeds\/[^/]+$/.test(r.url()) &&
          r.request().method() === "PUT",
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /Save/i }).click(),
    ]);
    expect(updateResp.status()).toBe(200);
    await expect(page.getByTestId("meeting-feed-name")).toContainText(renamed);

    /* ---------- Settle window ---------- */
    await page.waitForTimeout(3_000);
    const collected = failures();
    expect(
      collected,
      `CSP / pageerror / 401 / 5xx failures during journey:\n${collected
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
