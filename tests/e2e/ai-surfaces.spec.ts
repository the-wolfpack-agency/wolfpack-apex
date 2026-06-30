/**
 * AI Surface Inventory reality check (/admin/ai-surfaces).
 *
 * The "discover" demo beat: the page that shows every AI touchpoint and the
 * ungoverned gap. This proves, at the browser layer the jest suite cannot reach,
 * that the page is wired to its real API against a real DB and renders cleanly,
 * not a 200-that-shows-blank.
 *
 * Flow: sign in (skip cleanly if SMOKE creds are absent), load /admin/ai-surfaces,
 * assert 200 + not blank ("AI Surface Inventory"), the summary tiles OR the empty
 * state render, and ZERO CSP/network failures over a short idle window. Read-only
 * and non-destructive (it never triggers a scan).
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

test.describe("AI Surface Inventory reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/ai-surfaces renders the inventory (summary or empty) cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-surfaces`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ai-surfaces loads (not 401/blank)").toBe(200);

    // Not blank: the page title rendered.
    await expect(page.getByText("AI Surface Inventory", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    // Either the summary tiles or the empty state mounted (the data layer wired).
    const summary = page.getByTestId("ai-surfaces-summary");
    const empty = page.getByTestId("ai-surfaces-empty");
    await expect(summary.or(empty).first()).toBeVisible({ timeout: 15_000 });

    // No CSP/network failures while the page settled.
    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
