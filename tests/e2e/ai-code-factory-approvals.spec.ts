/**
 * Code Factory approval-surface reality check (mirrors ai-code-fitness.spec.ts).
 * Two paths: (1) unauthenticated -> redirect to /login (always); (2) authenticated
 * -> 200, the factory page mounts; the "Open PRs awaiting approval" panel renders
 * when the workspace has open factory PRs, otherwise it is correctly absent - either
 * way the page is not blank and there are zero CSP/network failures.
 */
import { test, expect } from "@playwright/test";
import {
  expectRendered, resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Code Factory approval surface", () => {
  test("unauthenticated /admin/ai-code/factory redirects to /login", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/ai-code/factory`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => null);
    expect(page.url().includes("/login")).toBe(true);
  });

  test("authenticated load renders the factory + approval panel cleanly", async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) { test.skip(true, "no SMOKE_TEST creds"); return; }
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-code/factory`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(nav?.status()).toBe(200);
    await expectRendered(page, "/admin/ai-code/factory", ["code factory"], { message: "factory page is not blank" });
    // The composer always mounts; the approval panel mounts only when PRs exist.
    await expect(page.getByTestId("composer")).toBeVisible({ timeout: 8_000 });
    const panel = page.getByTestId("open-pulls");
    if (await panel.count()) {
      // When present, an eligible row exposes an enabled Approve & merge control.
      await expect(panel).toBeVisible();
    }
    await page.waitForTimeout(3_000);
    expect(snapshot()).toEqual([]);
  });
});
