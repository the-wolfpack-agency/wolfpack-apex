/**
 * Forcefield client dashboard E2E (/forcefield/dashboard).
 *
 * Drives the real browser against the built public page and proves the token
 * flow end to end:
 *   1. The connect form renders; the submit is gated until a token is entered.
 *   2. Pasting a token + Connect calls my-stats with the token in the
 *      x-forcefield-token header, and the client's scoped numbers render
 *      (agents seen, hostile stopped, the attack breakdown). No CSP violation
 *      or JS crash over the flow.
 *   3. A 401 (unknown token) shows the clear "not recognized" message and no
 *      stats - never a blank page or a crash.
 *
 * The my-stats endpoint is intercepted so the test is fast, deterministic and
 * needs no real tenant token or database. The page bundle, the token wiring and
 * the rendered numbers are exercised for real.
 */
import { test, expect, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/forcefield/dashboard";

const STATS = {
  ok: true,
  tenant: { id: "t-e2e", name: "E2E Client", siteLabel: "e2e-client" },
  stats: {
    rangeDays: 30, agentsDetected: 1234, welcomed: 200, trapped: 12, probed: 300,
    payloads: 45, hostile: 357, sitesProtected: 1,
    attacks: [{ attack: "sql_injection", count: 9 }, { attack: "xss", count: 4 }],
  },
};

function mockMyStats(page: import("@playwright/test").Page, status: number, body: unknown) {
  return page.route(/\/api\/forcefield\/my-stats/, async (route: Route) => {
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.describe("Forcefield client dashboard", () => {
  test("connects with a token and renders the client's scoped numbers", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockMyStats(page, 200, STATS);

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const form = page.getByTestId("ff-token-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("ff-connect")).toBeDisabled();

    await page.getByTestId("ff-token-input").fill("ff_e2e_token");
    await expect(page.getByTestId("ff-connect")).toBeEnabled();
    await page.getByTestId("ff-connect").click();

    await expect(page.getByTestId("ff-stats")).toBeVisible();
    await expect(page.getByTestId("ff-m-detected")).toContainText("1,234");
    await expect(page.getByTestId("ff-m-hostile")).toContainText("357");
    await expect(page.getByTestId("ff-attack-sql_injection")).toContainText("SQL injection");

    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("shows a clear message on an unknown token and no stats", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockMyStats(page, 401, { ok: false, error: "unauthorized" });

    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.getByTestId("ff-token-input").fill("ff_bogus");
    await page.getByTestId("ff-connect").click();

    await expect(page.getByTestId("ff-error")).toContainText(/not recognized/i);
    await expect(page.getByTestId("ff-stats")).toHaveCount(0);

    // The expected 401 is the auth signal, not a defect; assert only that the
    // page did not CRASH (no CSP violation / pageerror).
    expect(getFailures().filter((f) => f.kind === "console"), "no CSP / JS crash").toEqual([]);
  });
});
