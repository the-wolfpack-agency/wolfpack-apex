/**
 * Model Fitness dashboard reality check (mirrors benchmark-dashboard.spec.ts).
 * Two paths: (1) unauthenticated -> redirect to /login (always); (2) authenticated
 * -> 200, the page mounts and renders the leaderboard OR an explicit empty state,
 * with zero CSP/network failures.
 */
import { test, expect } from "@playwright/test";
import {
  expectRendered, resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Model Fitness dashboard", () => {
  test("unauthenticated /admin/ai-code/fitness redirects to /login", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/ai-code/fitness`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => null);
    expect(page.url().includes("/login")).toBe(true);
  });

  test("authenticated load renders the fitness page cleanly", async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) { test.skip(true, "no SMOKE_TEST creds"); return; }
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-code/fitness`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(nav?.status()).toBe(200);
    await expectRendered(page, "/admin/ai-code/fitness", ["fitness", "model"], { message: "fitness page is not blank" });
    await expect(page.getByTestId("model-fitness-page")).toBeVisible({ timeout: 8_000 });
    const leaderboard = page.getByTestId("model-leaderboard");
    const empty = page.getByTestId("model-fitness-empty");
    expect((await leaderboard.count()) + (await empty.count())).toBeGreaterThan(0);
    await page.waitForTimeout(3_000);
    expect(snapshot()).toEqual([]);
  });
});
