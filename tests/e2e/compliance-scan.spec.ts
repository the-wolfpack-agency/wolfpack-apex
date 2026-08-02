/**
 * Compliance scan reality check (/admin/compliance-scan).
 *
 * The last place to catch a bug before a client does. Unit tests prove the
 * rules; this proves the page actually loads against the deployed app, renders
 * its controls, and does not throw CSP or network errors in a real browser.
 *
 * Read-only: it loads the page and submits with no target, which is refused by
 * the client before any request goes out. It deliberately does NOT run a scan,
 * because a scan reaches out to a real client site and an e2e run is not a
 * reason to do that.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL, like every
 * other page reality check here.
 */

import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Compliance scan reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/compliance-scan renders its controls cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/compliance-scan`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    // 200, not merely "not 500": a 401 renders a blank page, which is the bug
    // class this assertion exists for.
    expect(nav?.status(), "/admin/compliance-scan loads (not 401/blank)").toBe(200);

    await expect(page.getByRole("heading", { name: "Compliance scan" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Target")).toBeVisible();
    await expect(page.getByRole("button", { name: /run scan/i })).toBeEnabled();

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });

  test("refuses an empty target in the browser, before any request", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/compliance-scan`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    let scanRequested = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/compliance-scan") && r.method() === "POST") scanRequested = true;
    });

    await page.getByRole("button", { name: /run scan/i }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 5_000 });
    expect(scanRequested, "no scan is requested without a target").toBe(false);
  });
});
