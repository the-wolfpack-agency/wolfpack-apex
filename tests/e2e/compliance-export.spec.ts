/**
 * Signed compliance evidence export reality check (/admin/compliance).
 *
 * The "Comply" beat's forwardable artifact: from a stored report, a CISO/auditor
 * can download a signed evidence file instead of a login. This proves the export
 * CONTROL is wired into the page and the page renders cleanly against a real DB.
 * Read-only: it asserts the control's presence + clean console/network; it does
 * NOT trigger a real download in CI (no assertion on the downloaded bytes).
 *
 * Sign in (skip if SMOKE creds absent), load /admin/compliance, assert 200 +
 * not-blank + (history-or-empty render) and, when at least one report exists,
 * the "Download signed evidence" control is present. Zero CSP/network failures.
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Compliance signed-evidence export reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("/admin/compliance exposes the signed-evidence export control and renders cleanly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/compliance`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/compliance loads (not 401/blank)").toBe(200);

    await expect(page.getByText("Compliance", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    // Either there is report history (then the export control must be present)
    // or the empty state (no reports to export yet). Both are valid clean renders.
    const exportControl = page.getByTestId("compliance-export").first();
    const empty = page.getByTestId("compliance-empty");
    await expect(exportControl.or(empty).first()).toBeVisible({ timeout: 15_000 });

    if (await exportControl.count()) {
      await expect(exportControl).toBeVisible();
      await expect(exportControl).toBeEnabled();
    }

    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
  });
});
