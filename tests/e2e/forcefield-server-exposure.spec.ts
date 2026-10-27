/**
 * "Is your server exposed?" on the Forcefield client dashboard, in a real
 * browser against the built page.
 *
 * Every state the panel can show: exposed (version, flaw in plain words, who
 * fixes it), up to date, could not check (never shown as safe or exposed), the
 * never-reported empty state, and the load error. Plus: the page answers 200,
 * the credential goes in the x-forcefield-token header, no CSP violation or JS
 * error, and the panel fits a phone screen with no horizontal scroll.
 *
 * The dashboard endpoints are intercepted so the run is deterministic and needs
 * no real tenant. The report bodies are the real matcher's output
 * (buildExposureReport), so the copy under test is the copy that ships. The
 * live, unmocked proof on a real WordPress is forcefield-wordpress-live.spec.ts.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";
import { buildExposureReport, type ServerInventory } from "../../src/lib/forcefield-web/server-exposure";

const target = resolveSmokeTarget();
const PATH = "/forcefield/dashboard";
const TOKEN = "ff_e2e_exposure_token";
const TENANT = { id: "t-e2e", name: "E2E WordPress", siteLabel: "wp-e2e.example" };
const STATS = { ok: true, tenant: TENANT, stats: { rangeDays: 30, agentsDetected: 0, welcomed: 0, trapped: 0, probed: 0, payloads: 0, hostile: 0, sitesProtected: 1, attacks: [] } };

function report(inv: Partial<ServerInventory>) {
  const full: ServerInventory = { phpVersion: "8.4.27", wordpressVersion: "6.8.3", serverSoftware: "Apache/2.4.62", plugins: [], ...inv };
  return { ...buildExposureReport(full), phpVersion: full.phpVersion, wordpressVersion: full.wordpressVersion, receivedAt: "2026-10-27T12:00:00Z", firstReceivedAt: "2026-10-27T12:00:00Z" };
}

async function open(page: Page, exposure: { status: number; body: unknown }) {
  const seen: string[] = [];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\/forcefield\/my-stats$/, (r) => json(r, 200, STATS));
  await page.route(/\/api\/forcefield\/my-setup$/, (r) => json(r, 200, { ok: true, tenant: TENANT, quickstart: null, connection: { connected: true, everConnected: true, lastEventAt: "2026-10-27T00:00:00Z" } }));
  await page.route(/\/api\/forcefield\/alert-email$/, (r) => json(r, 200, { ok: true, notify: { email: "e2e@thewolfpack.agency", status: "confirmed", confirmedAt: "2026-10-27T00:00:00Z", restricted: true } }));
  await page.route(/\/api\/forcefield\/my-exposure$/, (r) => {
    seen.push(r.request().headers()["x-forcefield-token"] ?? "");
    return json(r, exposure.status, exposure.body);
  });
  await page.addInitScript((t) => window.localStorage.setItem("ff_dashboard_token", t), TOKEN);
  const res = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("ff-exposure")).toBeVisible({ timeout: 20_000 });
  return seen;
}

test.describe("Forcefield dashboard: Is your server exposed?", () => {
  test("exposed: the version, the flaw in plain words, and who fixes it", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    const seen = await open(page, { status: 200, body: { ok: true, report: report({ phpVersion: "8.3.10", plugins: [{ slug: "wp-file-manager", version: "6.8" }, { slug: "akismet", version: "5.3" }] }) } });
    await expect(page.getByTestId("ff-exposure-report")).toHaveAttribute("data-state", "exposed");
    await expect(page.getByTestId("ff-exposure-status")).toContainText("Exposed");
    const php = page.locator('[data-testid="ff-exposure-row"][data-key="php2shell:php"]');
    await expect(php).toHaveAttribute("data-state", "exposed");
    await expect(php).toContainText("Your server runs PHP 8.3.10, which is open to PHP2Shell, PHP server takeover");
    await expect(php.getByTestId("ff-exposure-fix")).toContainText("Your hosting company updates PHP. Ask them to move this site to PHP 8.3.36 or later");
    const fm = page.locator('[data-testid="ff-exposure-row"][data-key="wp_file_manager_rce:wp-file-manager"]');
    await expect(fm).toHaveAttribute("data-state", "exposed");
    await expect(fm.getByTestId("ff-exposure-fix")).toContainText("Update File Manager to 6.9 or later");
    await expect(page.getByTestId("ff-exposure-meta")).toContainText("1 other active plugin is not on the actively exploited list");
    expect(seen[0]).toBe(TOKEN);
    expect(failures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("up to date", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    await open(page, { status: 200, body: { ok: true, report: report({}) } });
    await expect(page.getByTestId("ff-exposure-report")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("ff-exposure-status")).toContainText("Up to date");
    await expect(page.getByTestId("ff-exposure-row")).toHaveCount(2);
    await expect(page.getByTestId("ff-exposure-fix")).toHaveCount(0);
    expect(failures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("could not check: says why, never safe or exposed", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    await open(page, { status: 200, body: { ok: true, report: report({ phpVersion: "8.3.6-1ubuntu1" }) } });
    await expect(page.getByTestId("ff-exposure-report")).toHaveAttribute("data-state", "unknown");
    await expect(page.getByTestId("ff-exposure-status")).toContainText("Could not check");
    const php = page.locator('[data-testid="ff-exposure-row"][data-key="php2shell:php"]');
    await expect(php).toHaveAttribute("data-state", "unknown");
    await expect(php).toContainText("Linux distribution build");
    await expect(page.getByTestId("ff-exposure-fix")).toHaveCount(0);
    expect(failures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("empty: the plugin has not reported yet", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    await open(page, { status: 200, body: { ok: true, report: null } });
    await expect(page.getByTestId("ff-exposure-empty")).toContainText("No server report yet");
    await expect(page.getByTestId("ff-exposure-report")).toHaveCount(0);
    expect(failures(), "no CSP violations or JS errors").toEqual([]);
  });

  test("a failed check shows an explicit error, and the rest of the dashboard still renders", async ({ page }) => {
    const failures = collectConsoleAndNetworkFailures(page);
    await open(page, { status: 503, body: { ok: false, error: "unavailable" } });
    await expect(page.getByTestId("ff-exposure-error")).toBeVisible();
    await expect(page.getByTestId("ff-stats")).toBeVisible();
    // The intercepted 503 is the scenario under test; assert only no crash / CSP.
    expect(failures().filter((f) => f.kind === "console"), "no CSP / JS crash").toEqual([]);
  });

  test("reload keeps the result; mobile fits with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const failures = collectConsoleAndNetworkFailures(page);
    await open(page, { status: 200, body: { ok: true, report: report({ phpVersion: "7.4.33" }) } });
    await expect(page.getByTestId("ff-exposure-report")).toHaveAttribute("data-state", "exposed");
    await expect(page.getByTestId("ff-exposure-fix").first()).toContainText("PHP 7.4 no longer gets security fixes");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ff-exposure-report")).toHaveAttribute("data-state", "exposed");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(failures(), "no CSP violations or JS errors").toEqual([]);
  });
});
