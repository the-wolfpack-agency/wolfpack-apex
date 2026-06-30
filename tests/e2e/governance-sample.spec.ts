/**
 * Governance sample reality check (/governance-sample).
 *
 * The public, no-login sample artifact a prospect can be sent as a URL. It must
 * load WITHOUT authentication (it lives outside the (dashboard) route group, the
 * same way /security-posture is public), render its key sections, and produce
 * zero CSP violations.
 *
 * Runs against PROD_URL if set, otherwise the local fallback. No sign-in: this is
 * a public page, so we deliberately do NOT call signInIfPossible. Registered in
 * the e2e-reality-check soft-spec list.
 */
import { test, expect } from "@playwright/test";
import {
  collectConsoleAndNetworkFailures,
  resolveSmokeTarget,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Governance sample public artifact", () => {
  test("/governance-sample loads 200 without login, key text visible, no CSP errors", async ({
    page,
  }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);

    const response = await page.goto(`${target.baseUrl}/governance-sample`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(response?.status(), "/governance-sample loads 200 unauthenticated").toBe(200);

    // Key sections are visible (the page is not blank and did not redirect to /login).
    await expect(page.getByTestId("governance-sample")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sample-disclaimer")).toBeVisible();
    await expect(page.getByText(/illustrative sample/i).first()).toBeVisible();
    await expect(page.getByTestId("surfaces-ungoverned")).toBeVisible();
    await expect(page.getByTestId("redteam-pass-rate")).toBeVisible();
    await expect(page.getByTestId("compliance-section")).toBeVisible();
    await expect(page.getByTestId("cta-request-scan")).toBeVisible();

    // It did not redirect to login (public artifact, no auth wall).
    expect(page.url(), "stayed on /governance-sample (no auth redirect)").toContain(
      "/governance-sample",
    );

    // Zero CSP violations or failed XHR/fetch during load + a short idle.
    await page.waitForTimeout(2_000);
    const failures = snapshot();
    expect(failures, `console/network failures: ${JSON.stringify(failures)}`).toHaveLength(0);
  });
});
