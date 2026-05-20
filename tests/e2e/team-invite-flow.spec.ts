/**
 * Team-invite + accept-invite E2E — CRITICAL FLOW.
 *
 * Validates that a CTO/CEO can invite a new team member and that the
 * invitee can complete the acceptance + sign in. Per
 * `feedback_critical_flows_executable_tests`, this test must drive the
 * REAL UI through every sub-step. Resend is the only thing stubbed at
 * the network layer so we don't send a real email; everything else
 * (DB writes, capability check, password hash, login) runs for real.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + INVITE_SMOKE_TARGET_EMAIL.
 * When any is missing the test is skipped so CI stays green on PRs that
 * don't configure the secrets. The CTO account must already exist in
 * the target environment (preview/prod).
 *
 * INVITE_SMOKE_TARGET_EMAIL is the email we'll invite — should be a
 * disposable address you control (e.g. invite-smoke@thewolfpack.agency).
 * The test cleans up nothing automatically; if your DB has a unique
 * constraint on team_members.email, run with a unique address per CI run
 * (e.g. by adding a suffix in the env value, or use a per-CI fresh DB).
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const inviteEmail = process.env.INVITE_SMOKE_TARGET_EMAIL;

test.describe("team invite + accept critical flow", () => {
  test.skip(
    !target.email || !target.password || !inviteEmail,
    "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + INVITE_SMOKE_TARGET_EMAIL not configured",
  );

  test("CTO invites teammate, teammate accepts, teammate signs in", async ({
    page,
    browser,
  }) => {
    // Stub Resend so we never send a real email — we capture the accept
    // URL directly off the response body instead.
    await page.route("https://api.resend.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "resend_stub" }),
      });
    });

    // ---- 1. Sign in as CTO ----
    const signedIn = await signInIfPossible(page, target);
    expect(signedIn).toBe(true);

    // ---- 2. Navigate to /hr, switch to Employees tab, click Invite ----
    await page.goto(`${target.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
    // The HR page exposes Employees as a tab. Click it if present (the
    // default tab might be Overview).
    const employeesTab = page.getByRole("button", { name: /employees/i }).first();
    if (await employeesTab.isVisible().catch(() => false)) {
      await employeesTab.click();
    }

    await page.getByTestId("open-invite-dialog").click();
    await expect(page.getByTestId("invite-member-dialog")).toBeVisible();

    // ---- 3. Fill invite form, submit ----
    await page.getByTestId("invite-member-email").fill(inviteEmail!);
    await page.getByTestId("invite-member-role").selectOption("ops");

    // Capture the API response so we have the real accept URL even if
    // the success-state UI changes shape later.
    const inviteResponsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/team/invite") && res.request().method() === "POST",
    );
    await page.getByTestId("invite-member-submit").click();
    const inviteResponse = await inviteResponsePromise;
    expect(inviteResponse.status()).toBe(201);
    const inviteBody = await inviteResponse.json();
    const acceptUrl: string = inviteBody.invites[0].acceptUrl;
    expect(acceptUrl).toContain("/accept-invite?token=");

    // Success state should show the URL too.
    await expect(page.getByTestId("invite-member-success")).toBeVisible();

    // ---- 4. Open accept-invite in a fresh context (no CTO cookies) ----
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    // Translate the URL's host to the test target so we don't accidentally
    // hop from preview to prod.
    const acceptParsed = new URL(acceptUrl);
    const targetParsed = new URL(target.baseUrl);
    acceptParsed.protocol = targetParsed.protocol;
    acceptParsed.host = targetParsed.host;
    await inviteePage.goto(acceptParsed.toString(), { waitUntil: "domcontentloaded" });

    await expect(inviteePage.getByTestId("accept-invite-page")).toBeVisible();

    const newPassword = `Smoke!${Date.now()}`;
    await inviteePage.getByTestId("accept-invite-password").fill(newPassword);
    await inviteePage.getByTestId("accept-invite-confirm").fill(newPassword);

    const acceptResponsePromise = inviteePage.waitForResponse(
      (res) => res.url().includes("/api/team/accept") && res.request().method() === "POST",
    );
    await inviteePage.getByTestId("accept-invite-submit").click();
    const acceptResponse = await acceptResponsePromise;
    expect(acceptResponse.status()).toBe(200);
    const acceptBody = await acceptResponse.json();
    expect(acceptBody.member_id).toMatch(/^tm_/);

    // Should redirect to /login with the invited flag + pre-filled email.
    await inviteePage.waitForURL(/\/login(\?.*)?$/, { timeout: 10_000 });
    const loginUrl = new URL(inviteePage.url());
    expect(loginUrl.searchParams.get("invited")).toBe("1");
    expect(loginUrl.searchParams.get("email")).toBe(inviteEmail!);

    // Email field is pre-filled so the operator can't sign in with the
    // wrong (e.g. personal) email and hit "Invalid credentials".
    const emailInput = inviteePage.locator('input[type="email"]').first();
    await expect(emailInput).toHaveValue(inviteEmail!);

    // ---- 5. Log in as the new teammate ----
    await emailInput.fill(inviteEmail!);
    await inviteePage.locator('input[type="password"]').first().fill(newPassword);
    const loginResponsePromise = inviteePage.waitForResponse(
      (res) => res.url().includes("/api/auth/login") && res.request().method() === "POST",
    );
    await inviteePage.locator('button[type="submit"]').first().click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.status()).toBe(200);

    // Landed somewhere authenticated.
    await inviteePage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
    const finalPath = new URL(inviteePage.url()).pathname;
    expect(finalPath).not.toBe("/login");

    await inviteeContext.close();
  });
});
