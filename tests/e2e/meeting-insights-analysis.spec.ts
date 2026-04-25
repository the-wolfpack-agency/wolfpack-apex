/**
 * Meeting Insights Phase 2 + 3 — Insights panel + Themes tab E2E.
 *
 * This walks the operator journey for a feed that already has
 * messages + analyses (i.e. assumes the test fixtures + ingest path
 * have populated the DB). When ingest hasn't run yet we still expect
 * the pages to render valid empty states — no blank pages, no 401s,
 * no CSP violations.
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

test.describe("/meetings/feeds — analysis + themes", () => {
  test("insights panel + themes tab render with valid empty/populated states", async ({
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

    /* ---------- Find a feed to inspect ---------- */
    const indexResp = await page.goto(`${target.baseUrl}/meetings/feeds`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(indexResp?.status()).toBe(200);

    const firstFeed = page.locator("a[href^='/meetings/feeds/']").first();
    if (!(await firstFeed.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, "no feeds available — earlier seed required");
      return;
    }
    const href = await firstFeed.getAttribute("href");
    expect(href).toBeTruthy();
    const slug = href!.replace("/meetings/feeds/", "");

    /* ---------- Themes tab ---------- */
    const themesResp = await page.goto(
      `${target.baseUrl}/meetings/feeds/${slug}/themes`,
      { waitUntil: "domcontentloaded", timeout: 20_000 },
    );
    expect(themesResp?.status()).toBe(200);

    // All three sections render — even when empty they show empty state
    await expect(page.getByTestId("themes-recurring")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("themes-stale")).toBeVisible();
    await expect(page.getByTestId("themes-action-items")).toBeVisible();
    await expect(page.getByTestId("themes-search")).toBeVisible();

    /* ---------- Search box ---------- */
    await page.getByLabel(/search messages/i).fill("review");
    const [searchResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/meetings/feeds/${slug}/search`),
        { timeout: 15_000 },
      ),
      page.getByRole("button", { name: /^Search$/i }).click(),
    ]);
    expect(searchResp.status()).toBe(200);
    await expect(page.getByTestId("themes-search-results")).toBeVisible();

    /* ---------- Drill into a message and check Insights renders ---------- */
    const messagesUrl = `${target.baseUrl}/meetings/feeds/${slug}`;
    await page.goto(messagesUrl, { waitUntil: "domcontentloaded" });
    const firstMessageLink = page
      .locator(`a[href^='/meetings/feeds/${slug}/messages/']`)
      .first();
    if (await firstMessageLink.isVisible({ timeout: 4_000 }).catch(() => false)) {
      const msgHref = await firstMessageLink.getAttribute("href");
      const msgResp = await page.goto(`${target.baseUrl}${msgHref}`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      expect(msgResp?.status()).toBe(200);
      await expect(page.getByTestId("meeting-insights")).toBeVisible({
        timeout: 10_000,
      });
      // Either the loading spinner, a populated body, an empty
      // message, or the analyzer-unavailable banner — at least ONE
      // is required, otherwise the panel is broken.
      const stateLocator = page.locator(
        '[data-testid="meeting-insights-loading"], [data-testid="meeting-insights-empty"], [data-testid="meeting-insights-unavailable"], [data-testid="insights-no-signal"], [data-testid="insights-topics"], [data-testid="insights-decisions"], [data-testid="insights-action-items"]',
      );
      await expect(stateLocator.first()).toBeVisible({ timeout: 10_000 });
    }

    /* ---------- Settle window ---------- */
    await page.waitForTimeout(3_000);
    const collected = failures();
    expect(
      collected,
      `CSP / pageerror / 401 / 5xx during analysis+themes journey:\n${collected
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
