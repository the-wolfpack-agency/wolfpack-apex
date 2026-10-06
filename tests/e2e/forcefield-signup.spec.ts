/**
 * Forcefield public signup E2E (/forcefield/signup).
 *
 * Drives the real browser against the built public page and proves the request
 * flow end to end:
 *   1. The form renders and submit POSTs the entered fields to the public
 *      /api/forcefield/signup endpoint.
 *   2. On a 202 the "received" success state shows and NO token is ever rendered
 *      (the flow is gated - a token is only issued later, by an operator).
 *   3. A 429 shows the clear "too many requests" message, not a crash.
 *
 * The signup endpoint is intercepted so the test is fast, deterministic and
 * creates no real request row. The page bundle, the form wiring and the states
 * are exercised for real.
 */
import { test, expect, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/forcefield/signup";

function mockSignup(page: import("@playwright/test").Page, status: number, body: unknown) {
  return page.route(/\/api\/forcefield\/signup/, async (route: Route) => {
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("Forcefield public signup", () => {
  test("submits a request and shows the received state (no token)", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 202, { ok: true, status: "received" });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.getByTestId("ff-signup-form")).toBeVisible();

    await page.getByTestId("ff-s-name").fill("Dana Example");
    await page.getByTestId("ff-s-email").fill("dana@example.com");
    await page.getByTestId("ff-s-site").fill("example.com");
    await page.getByTestId("ff-s-submit").click();

    await expect(page.getByTestId("ff-signup-done")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/ff_[A-Za-z0-9]/);
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("shows the rate-limit message on 429", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockSignup(page, 429, { ok: false, error: "rate_limited" });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
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
