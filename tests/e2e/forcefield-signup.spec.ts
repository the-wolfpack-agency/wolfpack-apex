/**
 * Forcefield public signup E2E (/forcefield/signup): action one of the two-step
 * onboarding, and the install option that is action two.
 *
 * Drives the real browser against the built public page:
 *   1. The page answers 200 and the form renders; submit stays disabled until
 *      BOTH required fields (website, email) are filled.
 *   2. A 201 self-serve answer shows the ONE install option for the platform the
 *      server detected: WordPress (the plugin download + the site's own wp-admin
 *      upload screen), Vercel / Next.js (the guided setup), other ("Connect it
 *      for me", which files the concierge request with the setup key). The DNS /
 *      file path stays one click away. No setup key or token is ever rendered.
 *   3. A 202 "request" answer (an address outside the Wolfpack recipient
 *      allowlist during the build phase) shows the "received" state.
 *   4. A 429 shows the clear "too many requests" message, not a crash.
 *   5. Mobile width: no horizontal scroll on the install step.
 * Every run asserts no CSP violation and no JS error.
 *
 * The endpoints are intercepted so the test is fast, deterministic and creates
 * no real request row. The full self-serve journey is forcefield-onboarding.spec.ts;
 * the real WordPress install is proven by forcefield-wordpress-live.spec.ts.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/forcefield/signup";
const SITE = "e2e-signup.thewolfpack.agency";
const EMAIL = "forcefield-e2e@thewolfpack.agency";

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function mockSignup(page: Page, status: number, body: unknown) {
  return page.route(/\/api\/forcefield\/onboarding$/, (route) => json(route, status, body));
}

const selfServe = (platform: string) => ({ ok: true, mode: "self_serve", requestId: "req-e2e", setupKey: "ffs_e2e_key", site: SITE, email: EMAIL, ownership: [], platform });

async function open(page: Page) {
  const res = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(res?.status(), "the signup page answers 200").toBe(200);
  await expect(page.getByTestId("ff-signup-form")).toBeVisible();
}

async function fillAndSubmit(page: Page, email = EMAIL, site = SITE) {
  await page.getByTestId("ff-s-site").fill(site);
  await page.getByTestId("ff-s-email").fill(email);
  await expect(page.getByTestId("ff-s-submit")).toBeEnabled();
  await page.getByTestId("ff-s-submit").click();
}

test.describe("Forcefield public signup", () => {
  test("required fields gate the submit", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await open(page);
    const submit = page.getByTestId("ff-s-submit");
    await expect(submit).toBeDisabled();
    await page.getByTestId("ff-s-site").fill(SITE);
    await expect(submit).toBeDisabled();
    await page.getByTestId("ff-s-email").fill(EMAIL);
    await expect(submit).toBeEnabled();
    await page.getByTestId("ff-s-site").fill("");
    await expect(submit).toBeDisabled();
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("WordPress: the plugin install option is shown", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 201, selfServe("wordpress"));
    await open(page);
    await fillAndSubmit(page);

    const install = page.getByTestId("ff-install");
    await expect(install).toBeVisible();
    await expect(install).toHaveAttribute("data-platform", "wordpress");
    await expect(install).toContainText(`${SITE} runs WordPress`);
    await expect(install).toContainText(EMAIL);
    await expect(page.getByTestId("ff-install-wordpress-button")).toHaveAttribute("href", "/api/forcefield/wordpress/plugin");
    await expect(page.getByTestId("ff-install-wordpress-upload")).toHaveAttribute("href", `https://${SITE}/wp-admin/plugin-install.php?tab=upload`);
    await expect(page.getByTestId("ff-install-vercel")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/ffs?_[A-Za-z0-9]/);
    expect(await page.evaluate(() => window.localStorage.getItem("ff_setup_key"))).toBe("ffs_e2e_key");
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("the plugin download serves an installable zip", async ({ request }) => {
    const res = await request.get(`${target.baseUrl}/api/forcefield/wordpress/plugin`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");
    const body = await res.body();
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
    expect(body.length).toBeGreaterThan(5000);
  });

  test("Vercel / Next.js: the guided setup option is shown and continues", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 201, selfServe("vercel"));
    await open(page);
    await fillAndSubmit(page);
    await expect(page.getByTestId("ff-install-vercel")).toBeVisible();
    await expect(page.getByTestId("ff-install")).toContainText("runs Vercel / Next.js");
    await page.getByTestId("ff-install-vercel-button").click();
    await expect(page).toHaveURL(/\/forcefield\/setup$/);
    expect(getFailures().filter((f) => f.kind === "console"), "no CSP violations or JS errors").toEqual([]);
  });

  test("other: 'Connect it for me' files the concierge request", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 201, selfServe("other"));
    let conciergeKey = "";
    await page.route(/\/api\/forcefield\/onboarding\/concierge$/, (route) => {
      conciergeKey = route.request().headers()["x-forcefield-setup"] ?? "";
      return json(route, 200, { ok: true });
    });
    await open(page);
    await fillAndSubmit(page);
    await expect(page.getByTestId("ff-install-other")).toBeVisible();
    await page.getByTestId("ff-install-concierge").click();
    await expect(page.getByTestId("ff-install-concierge-done")).toContainText(EMAIL);
    expect(conciergeKey).toBe("ffs_e2e_key");
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("submits a request and shows the received state (no token)", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 202, { ok: true, mode: "request" });
    await open(page);
    await page.getByTestId("ff-s-name").fill("Dana Example");
    await fillAndSubmit(page, "dana@example.com", "example.com");
    await expect(page.getByTestId("ff-signup-done")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/ffs?_[A-Za-z0-9]/);
    await expect(page).toHaveURL(/\/forcefield\/signup/);
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("shows the rate-limit message on 429", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 429, { ok: false, error: "rate_limited" });
    await open(page);
    await fillAndSubmit(page, "dana@example.com", "example.com");
    await expect(page.getByTestId("ff-signup-error")).toContainText(/too many requests/i);
    await expect(page.getByTestId("ff-signup-done")).toHaveCount(0);
    // The 429 is the expected signal; assert only that the page did not crash.
    expect(getFailures().filter((f) => f.kind === "console"), "no CSP / JS crash").toEqual([]);
  });

  test("mobile: the install step fits a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSignup(page, 201, selfServe("wordpress"));
    await open(page);
    await fillAndSubmit(page);
    await expect(page.getByTestId("ff-install-wordpress-button")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
  });
});
