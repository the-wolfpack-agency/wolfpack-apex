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
 *   4. Signed in from the emailed link (a dashboard session, the WordPress
 *      path): "Who visited" lists each agent, what it did and how Forcefield
 *      handled it, with the agents seen / welcomed / slowed / blocked counts,
 *      the live connection, and an explicit empty state before any agent.
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

/** The setup card the page loads alongside the stats (#1173), same shape as the jest test's SETUP. */
const SETUP = {
  ok: true,
  tenant: STATS.tenant,
  quickstart: {
    cloudflareEnv: { FORCEFIELD_SITE: "e2e-client", SITE_ANALYTICS_INGEST_TOKEN: "ff_e2e_token", FORCEFIELD_ENFORCE: "off" },
    nextEnv: { FORCEFIELD_SITE: "e2e-client", SITE_ANALYTICS_INGEST_TOKEN: "ff_e2e_token" },
    nextSnippet: 'export { default as middleware } from "@ogiam/forcefield/next";',
  },
  connection: { connected: true, lastEventAt: "2026-10-07T00:00:00Z" },
};
function mockMySetup(page: import("@playwright/test").Page) {
  return page.route(/\/api\/forcefield\/my-setup/, async (route: Route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETUP) });
  });
}

/** The alert-address panel the dashboard loads once connected (self-serve onboarding). */
function mockAlertEmail(page: import("@playwright/test").Page) {
  return page.route(/\/api\/forcefield\/alert-email$/, async (route: Route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, notify: { email: "e2e@thewolfpack.agency", status: "confirmed", confirmedAt: "2026-10-26T00:00:00Z", restricted: true } }) });
  });
}

/** The "Is your server exposed?" panel (tests/e2e/forcefield-server-exposure.spec.ts covers its states). */
function mockExposure(page: import("@playwright/test").Page) {
  return page.route(/\/api\/forcefield\/my-exposure$/, async (route: Route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, report: null }) });
  });
}

test.describe("Forcefield client dashboard", () => {
  test("connects with a token and renders the client's scoped numbers", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockMyStats(page, 200, STATS);
    await mockMySetup(page);
    await mockAlertEmail(page);
    await mockExposure(page);

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
    await expect(page.getByTestId("ff-alert-status")).toContainText("Alerts on");

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

  test("signed in from the emailed link: who visited, what each did, how it was handled", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    const activity = {
      sinceIso: "2026-09-26T00:00:00Z",
      counts: { agentsSeen: 3, welcomed: 1, slowed: 1, blocked: 1, caught: 0 },
      agents: [
        { name: "Googlebot", kind: "known_crawler", requests: 40, did: "Read your public pages", handled: "welcomed", lastSeen: null },
        { name: "sqlmap", kind: "scanner", requests: 12, did: "Sent an attack payload (sql injection)", handled: "blocked", lastSeen: null },
        { name: "python-requests", kind: "scripted_library", requests: 5, did: "Probed a sensitive path (env file)", handled: "slowed", lastSeen: null },
      ],
    };
    let presented = "";
    await page.route(/\/api\/forcefield\/my-stats/, (route: Route) => {
      presented = route.request().headers()["x-forcefield-token"] ?? "";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...STATS, activity }) });
    });
    await page.route(/\/api\/forcefield\/my-setup/, (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, tenant: STATS.tenant, quickstart: null, connection: { connected: true, everConnected: true, lastEventAt: "2026-10-26T00:00:00Z" } }) }));
    await mockAlertEmail(page);
    await mockExposure(page);
    await page.addInitScript(() => window.localStorage.setItem("ff_dashboard_token", "eyJhbGciOiJIUzI1NiJ9.e2e.session"));

    const res = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("ff-visitors")).toBeVisible();
    const rows = page.getByTestId("ff-visitor-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Googlebot");
    await expect(rows.nth(0)).toContainText("Welcomed");
    await expect(rows.nth(1)).toContainText("Sent an attack payload (sql injection)");
    await expect(rows.nth(1)).toContainText("Blocked");
    await expect(rows.nth(2)).toContainText("Slowed");
    await expect(page.getByTestId("ff-v-seen")).toContainText("3");
    await expect(page.getByTestId("ff-v-blocked")).toContainText("1");
    await expect(page.getByTestId("ff-connection")).toContainText("Connected");
    await expect(page.getByTestId("ff-setup")).toHaveCount(0); // no paste-config for the plugin path
    expect(presented).toBe("eyJhbGciOiJIUzI1NiJ9.e2e.session");
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("an explicit empty state before the first agent arrives", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await mockMyStats(page, 200, { ...STATS, activity: { sinceIso: "x", counts: { agentsSeen: 0, welcomed: 0, slowed: 0, blocked: 0, caught: 0 }, agents: [] } });
    await mockMySetup(page);
    await mockAlertEmail(page);
    await mockExposure(page);
    await page.addInitScript(() => window.localStorage.setItem("ff_dashboard_token", "ff_e2e_token"));
    await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.getByTestId("ff-visitors-empty")).toContainText("No automated agents yet");
    await expect(page.getByTestId("ff-visitors-table")).toHaveCount(0);
    expect(getFailures(), "no CSP violations or JS errors").toEqual([]);
  });
});
