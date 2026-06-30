/**
 * Admin MFA settings-section reality check (/settings#mfa).
 *
 * The opt-in multi-factor auth section lives in the Settings page. This spec
 * proves, at the browser layer the jest suite can't reach, that:
 *   1. An unauthenticated visit to /settings redirects to /login (never a
 *      silent blank) — runs unconditionally, needs no creds.
 *   2. An authenticated load (gated on SMOKE creds) renders the MFA section
 *      (the "Multi-factor authentication" SectionCard + the mfa-settings-card
 *      testid in one of its states) with ZERO CSP / network failures.
 *
 * READ-ONLY by design: it never clicks "Enable MFA" / submits a code / disables
 * MFA, so it performs no real enrollment and pollutes no prod account state.
 * It only asserts the section renders. Enrollment correctness is covered by the
 * jest unit + contract + RTL tests.
 *
 * Auth-helper limitation mirrors agent-detail-console.spec.ts: signInIfPossible
 * is credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD
 * against PROD_URL. When those are absent the authenticated path skips cleanly;
 * the unauth-redirect path always runs.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SETTINGS_PATH = "/settings";

test.describe("Admin MFA settings reality check", () => {
  test("unauthenticated visit to /settings redirects to /login (never blank)", async ({ page }) => {
    await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 });
    expect(page.url()).toContain("/login");
  });

  test("authenticated /settings renders the MFA section with no CSP/network failures", async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    test.skip(!signedIn, "SMOKE_TEST_EMAIL/PASSWORD not set — skipping authenticated MFA-section render");

    const getFailures = collectConsoleAndNetworkFailures(page);

    await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // The MFA SectionCard heading proves the section is wired into the page.
    await expect(page.getByText(/Multi-factor authentication/i)).toBeVisible({ timeout: 15_000 });

    // The card renders in one of its states (loading -> disabled/confirmed).
    const card = page.getByTestId("mfa-settings-card");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Settle, then assert no CSP violations or broken (401/403/5xx) XHR/fetch.
    await page.waitForTimeout(3_000);
    const failures = getFailures();
    expect(failures, `Unexpected console/network failures:\n${failures.map((f) => f.detail).join("\n")}`).toEqual([]);
  });
});
