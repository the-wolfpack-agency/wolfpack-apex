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
 * ENFORCEMENT JOURNEYS (the second describe block). Admin MFA is enforced for
 * admin-capable accounts (src/lib/auth/mfa.ts). Those journeys stub the session
 * and intercept /api/auth/mfa/*, so the REAL deployed bundle (dashboard layout
 * redirect, /mfa page, enrollment card, challenge form) runs against each
 * server answer with no credentials and no real enrollment:
 *   - an unenrolled admin is sent to /mfa and shown enrollment;
 *   - an enrolled admin is challenged, a wrong code is refused on the page,
 *     and the right code returns them to where they were going;
 *   - an admin who already passed (or is exempt) is not redirected;
 *   - a non-admin is unaffected and sees MFA described as optional;
 *   - an unauthenticated /mfa visit goes to /login, never a blank page;
 *   - /mfa fits a phone (no sideways scroll) with no CSP violations.
 * The server half (the 403 every admin API returns until enrolled) is covered
 * by src/lib/auth/__tests__/require-capability-mfa-gate.test.ts.
 *
 * Auth-helper limitation mirrors agent-detail-console.spec.ts: signInIfPossible
 * is credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD
 * against PROD_URL. When those are absent the authenticated path skips cleanly;
 * the unauth-redirect path always runs.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  stubInstinctSession,
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

type Required = null | "enroll" | "challenge";

/** Intercept the MFA API. `state.required` can change mid-test (after a challenge). */
async function stubMfaApi(page: Page, state: { required: Required; enforced: boolean; confirmed: boolean }) {
  const posts: { path: string; body: unknown }[] = [];
  // Any other API call from the dashboard gets an empty 200, so the journey is
  // about MFA and not about whichever widgets the page happens to load.
  // whoami / refresh fall through to stubInstinctSession's handlers.
  await page.route("**/api/**", async (route) => {
    if (/\/api\/auth\/(whoami|refresh)/.test(route.request().url())) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/auth/mfa/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enrolled: state.confirmed,
        confirmed: state.confirmed,
        recoveryCodesRemaining: state.confirmed ? 10 : 0,
        confirmedAt: state.confirmed ? "2026-10-01T00:00:00.000Z" : null,
        enforced: state.enforced,
        required: state.required,
      }),
    });
  });
  await page.route("**/api/auth/mfa/challenge", async (route) => {
    const body = route.request().postDataJSON() as { code?: string };
    posts.push({ path: "challenge", body });
    if (body.code === "123456") {
      state.required = null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, usedRecoveryCode: false, recoveryCodesRemaining: 10 }),
      });
    } else {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "bad_code" }) });
    }
  });
  await page.route("**/api/auth/mfa/enroll", async (route) => {
    posts.push({ path: "enroll", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Instinct:cto?secret=JBSWY3DPEHPK3PXP" }),
    });
  });
  return { posts };
}

/** The deployed build may predate /mfa (the post-merge run can beat the deploy). */
async function mfaPageDeployed(page: Page): Promise<boolean> {
  const res = await page.request.get(`${target.baseUrl}/mfa`, { failOnStatusCode: false });
  return res.status() === 200;
}

test.describe("Admin MFA enforcement journeys", () => {
  test("an unenrolled admin is redirected to /mfa and shown enrollment", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await stubInstinctSession(page, { id: "u-cto", role: "cto", email: "cto@instinct.local" });
    const { posts } = await stubMfaApi(page, { required: "enroll", enforced: true, confirmed: false });
    const failures = collectConsoleAndNetworkFailures(page);

    const res = await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);
    await page.waitForURL((url) => url.pathname === "/mfa", { timeout: 20_000 });
    expect(new URL(page.url()).searchParams.get("next")).toBe(SETTINGS_PATH);

    await expect(page.getByTestId("mfa-page")).toHaveAttribute("data-view", "enroll", { timeout: 15_000 });
    await expect(page.getByTestId("mfa-page-enroll")).toBeVisible();
    await expect(page.getByTestId("mfa-intro")).toContainText(/Required for your account/i);

    // The enrollment card is live, not a dead widget: starting enrollment posts.
    await page.getByTestId("mfa-enable-btn").click();
    await expect.poll(() => posts.filter((p) => p.path === "enroll").length).toBeGreaterThan(0);

    const csp = failures().filter((f) => f.detail.startsWith("CSP:"));
    expect(csp, csp.map((f) => f.detail).join("\n")).toEqual([]);
  });

  test("an enrolled admin is challenged; a wrong code is refused, the right one returns them", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await stubInstinctSession(page, { id: "u-cto", role: "cto", email: "cto@instinct.local" });
    const state = { required: "challenge" as Required, enforced: true, confirmed: true };
    const { posts } = await stubMfaApi(page, state);

    await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/mfa", { timeout: 20_000 });
    await expect(page.getByTestId("mfa-page-challenge")).toBeVisible({ timeout: 15_000 });

    // Malformed: refused on the page, nothing posted.
    await page.getByTestId("mfa-challenge-input").fill("12");
    await page.getByTestId("mfa-challenge-submit").click();
    await expect(page.getByTestId("mfa-page-error")).toBeVisible();
    expect(posts.filter((p) => p.path === "challenge")).toHaveLength(0);

    // Wrong code: the server says bad_code, the page says so and stays.
    await page.getByTestId("mfa-challenge-input").fill("000000");
    await page.getByTestId("mfa-challenge-submit").click();
    await expect(page.getByTestId("mfa-page-error")).toContainText(/didn't match/i);
    expect(new URL(page.url()).pathname).toBe("/mfa");

    // Right code: back to where they were going, and not bounced again.
    await page.getByTestId("mfa-challenge-input").fill("123456");
    await page.getByTestId("mfa-challenge-submit").click();
    await page.waitForURL((url) => url.pathname === SETTINGS_PATH, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(SETTINGS_PATH);
    expect(posts.filter((p) => p.path === "challenge").map((p) => (p.body as { code: string }).code)).toEqual(["000000", "123456"]);
  });

  test("an admin who has passed MFA is not redirected", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await stubInstinctSession(page, { id: "u-cto", role: "cto", email: "cto@instinct.local" });
    await stubMfaApi(page, { required: null, enforced: true, confirmed: true });

    await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-boot-splash")).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(SETTINGS_PATH);
  });

  test("a non-admin is unaffected and sees MFA as optional", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await stubInstinctSession(page, { id: "u-sales", role: "sales", email: "sales@instinct.local" });
    await stubMfaApi(page, { required: null, enforced: false, confirmed: false });

    await page.goto(`${target.baseUrl}${SETTINGS_PATH}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-boot-splash")).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    expect(new URL(page.url()).pathname).toBe(SETTINGS_PATH);
    const intro = page.getByTestId("mfa-intro");
    if (await intro.count()) await expect(intro).toContainText(/Optional/i);
  });

  test("an unauthenticated visit to /mfa goes to /login (never blank)", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await page.goto(`${target.baseUrl}/mfa`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 });
    expect(new URL(page.url()).searchParams.get("next")).toMatch(/^\/mfa/);
  });

  test("/mfa fits a phone with no sideways scroll and no CSP violations", async ({ page }) => {
    test.skip(!(await mfaPageDeployed(page)), "deployed build has no /mfa page yet");
    await page.setViewportSize({ width: 375, height: 760 });
    await stubInstinctSession(page, { id: "u-cto", role: "cto", email: "cto@instinct.local" });
    await stubMfaApi(page, { required: "challenge", enforced: true, confirmed: true });
    const failures = collectConsoleAndNetworkFailures(page);

    await page.goto(`${target.baseUrl}/mfa`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("mfa-page-challenge")).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const csp = failures().filter((f) => f.detail.startsWith("CSP:"));
    expect(csp, csp.map((f) => f.detail).join("\n")).toEqual([]);
  });
});
