/**
 * Model router reality check (/admin/ai-router).
 *
 * The UI is where every part of the system meets, so this is the last place a
 * bug shows before a client conversation does. Read-only: it loads the page,
 * asserts the panels render against the real API and real configuration, and
 * asserts no CSP or network errors in a real browser.
 *
 * The assertion with teeth is the one about the word "estimated". Cost figures
 * on a page get quoted to people; if the deployed page ever drops the
 * qualifier, someone reconciles it against an invoice and finds it wrong.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Model router reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/ai-router renders against real configuration", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-router`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    // 200, not merely "not 500": a 401 renders blank.
    expect(nav?.status(), "/admin/ai-router loads (not 401/blank)").toBe(200);

    await expect(page.getByRole("heading", { name: "Model router" })).toBeVisible({ timeout: 15_000 });

    // Whichever state the activity panel settles in, one of them must render.
    const headline = page.getByTestId("router-headline");
    const unavailable = page.getByTestId("router-unavailable");
    await expect(headline.or(unavailable).first()).toBeVisible({ timeout: 15_000 });

    // The model list comes from the deployment's own configuration, so it
    // proves the page is wired to something real rather than a fixture.
    await expect(page.getByTestId("router-models")).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });

  test("never presents an estimated cost as billed", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/ai-router`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const cost = page.getByTestId("router-metric-cost");
    if (await cost.isVisible().catch(() => false)) {
      await expect(cost).toContainText(/estimated/i);
      await expect(cost).toContainText(/not billed/i);
    }
  });
});
