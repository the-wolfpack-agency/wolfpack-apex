/**
 * Forcefield public signup E2E (/forcefield/signup), the build-phase request path.
 *
 * Drives the real browser against the built public page:
 *   1. The form renders and submit POSTs the entered fields to the public
 *      /api/forcefield/onboarding endpoint.
 *   2. On a 202 "request" answer (an address outside the Wolfpack recipient
 *      allowlist during the build phase) the "received" state shows and NO token
 *      or setup key is ever rendered.
 *   3. A 429 shows the clear "too many requests" message, not a crash.
 *
 * The endpoint is intercepted so the test is fast, deterministic and creates no
 * real request row. The full self-serve journey is forcefield-onboarding.spec.ts.
 */
import { test, expect, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/forcefield/signup";

function mockSignup(page: import("@playwright/test").Page, status: number, body: unknown) {
  return page.route(/\/api\/forcefield\/onboarding$/, async (route: Route) => {
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("Forcefield public signup", () => {
  test("submits a request and shows the received state (no token)", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 202, { ok: true, mode: "request" });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.getByTestId("ff-signup-form")).toBeVisible();

    await expect(page.getByTestId("ff-s-submit")).toBeEnabled();
    await page.getByTestId("ff-s-name").fill("Dana Example");
    await page.getByTestId("ff-s-email").fill("dana@example.com");
    await page.getByTestId("ff-s-site").fill("example.com");
    await page.getByTestId("ff-s-submit").click();

    await expect(page.getByTestId("ff-signup-done")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/ffs?_[A-Za-z0-9]/);
    await expect(page).toHaveURL(/\/forcefield\/signup/);
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("shows the rate-limit message on 429", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 429, { ok: false, error: "rate_limited" });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.getByTestId("ff-s-submit")).toBeEnabled();
    await page.getByTestId("ff-s-name").fill("Dana");
    await page.getByTestId("ff-s-email").fill("dana@example.com");
    await page.getByTestId("ff-s-site").fill("example.com");
    await page.getByTestId("ff-s-submit").click();

    await expect(page.getByTestId("ff-signup-error")).toContainText(/too many requests/i);
    await expect(page.getByTestId("ff-signup-done")).toHaveCount(0);
    // The 429 is the expected signal; assert only that the page did not crash.
    expect(getFailures().filter((f) => f.kind === "console"), "no CSP / JS crash").toEqual([]);
  });
});
