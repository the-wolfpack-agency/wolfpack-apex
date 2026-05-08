/**
 * Password reset E2E — CRITICAL FLOW.
 *
 * Drives the real UI through every sub-step of self-service reset:
 *   1. /login → click "Forgot password?"
 *   2. /forgot-password → enter email → submit
 *   3. Capture the reset URL (from the dev_link surface OR by stubbing
 *      Resend at the network seam if it's wired)
 *   4. Open the reset URL in a fresh context → set new password → submit
 *   5. Land on /login?reset=1 → sign in with the new password
 *   6. Confirm authenticated route (not /login)
 *
 * Per `feedback_critical_flows_executable_tests.md`, this exercises the
 * real UI + real DB writes; only the Resend network call is stubbed.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + RESET_SMOKE_EMAIL.
 *   - SMOKE_TEST_EMAIL/PASSWORD: a CTO/owner that exists in the target
 *     environment (used only to confirm /login renders for live targets)
 *   - RESET_SMOKE_EMAIL: a disposable team-member email whose password
 *     this test will reset. Use a per-CI-run unique value (e.g.
 *     reset-smoke-${random}@thewolfpack.agency) to avoid clobbering a
 *     human's account.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const resetEmail = process.env.RESET_SMOKE_EMAIL;

test.describe("password reset critical flow", () => {
  test.skip(
    !target.email || !target.password || !resetEmail,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + RESET_SMOKE_EMAIL not configured",
  );

  test("user requests a reset, sets a new password, and signs in with it", async ({
    page,
    browser,
  }) => {
    // Stub Resend so we never send a real email. Even if RESEND_API_KEY
    // is set in CI, the dev_link fallback ensures we have the URL to
    // navigate to without inbox-scraping.
    await page.route("https://api.resend.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "resend_stub" }),
      });
    });

    // ---- 1. Navigate from login → forgot password ----
    await page.goto(`${target.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("forgot-password-link").click();
    await expect(page.getByTestId("forgot-password-form")).toBeVisible();

    // ---- 2. Submit forgot-password form ----
    await page.getByTestId("forgot-password-email").fill(resetEmail!);
    const forgotResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/forgot-password") &&
        res.request().method() === "POST",
    );
    await page.getByTestId("forgot-password-submit").click();
    const forgotResponse = await forgotResponsePromise;
    expect(forgotResponse.status()).toBe(200);
    const forgotBody = await forgotResponse.json();

    // The dev_link is surfaced when Resend stub returns success without
    // RESEND_API_KEY (server treats it as "delivery skipped"). Either
    // we get a dev_link, or we need to read it from the success state
    // which renders the link verbatim under data-testid.
    const devLink: string | undefined =
      forgotBody.dev_link ||
      (await page
        .getByTestId("forgot-password-dev-link")
        .textContent()
        .then((t) => t?.match(/https?:\/\/\S+/)?.[0]));
    expect(devLink, "expected a reset URL via dev_link").toBeTruthy();

    // ---- 3. Open the reset URL in a fresh context (no cookies) ----
    const resetContext = await browser.newContext();
    const resetPage = await resetContext.newPage();

    // Translate the URL host to the test target so we don't accidentally
    // hop from preview to prod.
    const parsed = new URL(devLink!);
    const targetParsed = new URL(target.baseUrl);
    parsed.protocol = targetParsed.protocol;
    parsed.host = targetParsed.host;
    await resetPage.goto(parsed.toString(), { waitUntil: "domcontentloaded" });
    await expect(resetPage.getByTestId("reset-password-page")).toBeVisible();

    // ---- 4. Set new password ----
    const newPassword = `Reset!${Date.now()}`;
    await resetPage.getByTestId("reset-password-input").fill(newPassword);
    await resetPage.getByTestId("reset-password-confirm").fill(newPassword);

    const resetResponsePromise = resetPage.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/reset-password") &&
        res.request().method() === "POST",
    );
    await resetPage.getByTestId("reset-password-submit").click();
    const resetResponse = await resetResponsePromise;
    expect(resetResponse.status()).toBe(200);

    // Should redirect to /login?reset=1
    await resetPage.waitForURL(/\/login(\?.*)?$/, { timeout: 10_000 });

    // ---- 5. Sign in with the new password ----
    await resetPage.locator('input[type="email"]').first().fill(resetEmail!);
    await resetPage.locator('input[type="password"]').first().fill(newPassword);

    const loginResponsePromise = resetPage.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/login") &&
        res.request().method() === "POST",
    );
    await resetPage.locator('button[type="submit"]').first().click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.status()).toBe(200);

    // ---- 6. Authenticated route reached (not still on /login) ----
    await resetPage.waitForURL(
      (url) => !url.pathname.startsWith("/login"),
      { timeout: 15_000 },
    );
    const finalPath = new URL(resetPage.url()).pathname;
    expect(finalPath).not.toBe("/login");

    await resetContext.close();
  });
});
