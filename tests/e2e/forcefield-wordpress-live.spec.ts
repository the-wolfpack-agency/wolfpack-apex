/**
 * Forcefield two-step onboarding on a REAL WordPress, end to end, no stubs.
 *
 * Skipped unless FF_WP_URL is set. Runs against a throwaway local WordPress
 * (the official wordpress + mysql Docker images) and a local Instinct dev
 * server on a real Postgres. The runbook and the one command that sets it all
 * up are in docs/forcefield/self-serve-onboarding.md ("Local WordPress proof").
 *
 *   1. /forcefield/signup: website + email; the server's read-only check of the
 *      site's home page finds WordPress and shows the plugin option.
 *   2. The plugin zip from that option is uploaded and activated in wp-admin.
 *   3. Settings -> Forcefield -> Connect: the plugin answers the server's
 *      challenge from the site; "Check your email" is shown.
 *   4. The sign-in link (read from the local dev outbox, nothing is sent) is
 *      opened and clicked: the address is confirmed and the browser is signed
 *      in to the dashboard.
 *   5. The plugin collects its key: the settings page shows Connected.
 *   6. Automated visitors reach the WordPress site; the dashboard shows each
 *      agent, what it did and how Forcefield handled it.
 *   7. "Is your server exposed?": the plugin reported its server on link, and
 *      the panel matches the PHP the image really runs (FF_EXPECT_EXPOSURE).
 * Every Instinct page answers 200 with no CSP violation or JS error.
 *
 * Env: FF_WP_URL (http://wp.localtest.me:8080), FF_WP_USER, FF_WP_PASS,
 * FF_OUTBOX_DIR (the dev server's FORCEFIELD_MAIL_OUTBOX_DIR), FF_EMAIL
 * (a thewolfpack.agency address; the build-phase rule), FF_PROOF_DIR (where
 * screenshots and the tenant id are written), FF_EXPECT_EXPOSURE (exposed |
 * ok: the panel state this image's PHP must produce; unset = any reported
 * state, never the empty or error state).
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const WP = process.env.FF_WP_URL?.replace(/\/$/, "") ?? "";
const USER = process.env.FF_WP_USER ?? "ffadmin";
const PASS = process.env.FF_WP_PASS ?? "";
const OUTBOX = process.env.FF_OUTBOX_DIR ?? "";
const EMAIL = process.env.FF_EMAIL ?? "forcefield-wp-proof@thewolfpack.agency";
const PROOF = process.env.FF_PROOF_DIR ?? "test-results/ff-wp-proof";
const EXPECT_EXPOSURE = process.env.FF_EXPECT_EXPOSURE ?? "";
const target = resolveSmokeTarget();
const site = () => new URL(WP).host;

test.skip(!WP || !PASS || !OUTBOX, "set FF_WP_URL, FF_WP_PASS and FF_OUTBOX_DIR to run the live WordPress proof");
test.describe.configure({ mode: "serial", timeout: 240_000 });

async function shot(page: Page, name: string) {
  mkdirSync(PROOF, { recursive: true });
  await page.screenshot({ path: join(PROOF, `${name}.png`), fullPage: true });
}

async function wpLogin(page: Page) {
  await page.goto(`${WP}/wp-login.php`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("wp-admin")) return;
  await page.fill("#user_login", USER);
  await page.fill("#user_pass", PASS);
  await page.click("#wp-submit");
  await page.waitForURL(/wp-admin/, { timeout: 30_000 });
}

function newestConfirmLink(since: number): string | null {
  const files = readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.reverse()) {
    const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string; purpose: string; text: string };
    const at = Date.parse(f.slice(0, 24).replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "$1:$2:$3.$4Z"));
    if (m.purpose === "confirm" && m.to === EMAIL && (!Number.isFinite(at) || at >= since - 5000)) {
      return /(https?:\/\/\S+\/forcefield\/confirm\?token=\S+)/.exec(m.text)?.[1] ?? null;
    }
  }
  return null;
}

test("a site owner gets running on Forcefield in two actions", async ({ page, request }) => {
  const failures = collectConsoleAndNetworkFailures(page);
  const instinctFailures = () => failures().filter((f) => f.detail.includes(target.baseUrl) || f.kind === "console");

  // 1. Signup: the platform check finds WordPress.
  const signup = await page.goto(`${target.baseUrl}/forcefield/signup`, { waitUntil: "domcontentloaded" });
  expect(signup?.status()).toBe(200);
  await page.getByTestId("ff-s-site").fill(WP);
  await page.getByTestId("ff-s-email").fill(EMAIL);
  await page.getByTestId("ff-s-submit").click();
  await expect(page.getByTestId("ff-install")).toHaveAttribute("data-platform", "wordpress", { timeout: 30_000 });
  await shot(page, "1-signup-wordpress-detected");
  expect(instinctFailures(), "signup: no CSP violations or JS errors").toEqual([]);

  // 2. Install the plugin from the button's zip.
  const href = await page.getByTestId("ff-install-wordpress-button").getAttribute("href");
  const zip = await request.get(`${target.baseUrl}${href}`);
  expect(zip.status()).toBe(200);
  mkdirSync(PROOF, { recursive: true });
  const zipPath = join(PROOF, "ogiam-forcefield.zip");
  writeFileSync(zipPath, await zip.body());

  await wpLogin(page);
  await page.goto(`${WP}/wp-admin/plugin-install.php?tab=upload`, { waitUntil: "domcontentloaded" });
  await page.setInputFiles("#pluginzip", zipPath);
  await page.click("#install-plugin-submit");
  await expect(page.locator("body")).toContainText(/Plugin installed successfully|Destination folder already exists/, { timeout: 60_000 });
  const activate = page.locator("a.button-primary", { hasText: /Activate Plugin/ });
  if (await activate.count()) await activate.click();
  else await page.goto(`${WP}/wp-admin/plugins.php`);
  await expect(page.locator('tr[data-slug="ogiam-forcefield"]')).toHaveClass(/active/, { timeout: 30_000 });
  await shot(page, "2-plugin-active");

  // 3. Connect: the plugin proves it runs on the site.
  const started = Date.now();
  await page.goto(`${WP}/wp-admin/options-general.php?page=ogiam-forcefield`, { waitUntil: "domcontentloaded" });
  await page.fill("#ogiam_ff_email", EMAIL);
  await page.click("#ogiam-ff-connect-button");
  await expect(page.locator("#ogiam-ff-awaiting")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#ogiam-ff-awaiting")).toContainText("This site is verified");
  await shot(page, "3-plugin-check-your-email");

  // 4. The sign-in link from the outbox (dev only: nothing was sent).
  let link: string | null = null;
  for (let i = 0; i < 20 && !link; i++) {
    link = newestConfirmLink(started);
    if (!link) await page.waitForTimeout(500);
  }
  expect(link, "a confirmation email for the address entered in the plugin").toBeTruthy();
  const confirm = await page.goto(link!, { waitUntil: "domcontentloaded" });
  expect(confirm?.status()).toBe(200);
  await page.getByTestId("ff-confirm-button").click();
  await expect(page.getByTestId("ff-confirm-done")).toContainText("you are signed in");
  await shot(page, "4-sign-in-link-confirmed");
  expect(await page.evaluate(() => window.localStorage.getItem("ff_dashboard_token"))).toBeTruthy();

  // 5. The plugin collects its key.
  await page.goto(`${WP}/wp-admin/options-general.php?page=ogiam-forcefield`, { waitUntil: "domcontentloaded" });
  if (!(await page.locator("#ogiam-ff-connect h2", { hasText: "Connected" }).count())) {
    await page.click("#ogiam-ff-check");
  }
  await expect(page.locator("#ogiam-ff-connect h2")).toHaveText("Connected", { timeout: 30_000 });
  await shot(page, "5-plugin-connected");

  // 6. Automated visitors reach the WordPress site (watch mode: all served).
  const visits: [string, string][] = [
    ["/", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["/?p=1", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["/?id=1%27%20OR%201%3D1--", "sqlmap/1.8.2#stable (https://sqlmap.org)"],
    ["/?s=%3Cscript%3Ealert(1)%3C%2Fscript%3E", "sqlmap/1.8.2#stable (https://sqlmap.org)"],
    ["/.env", "python-requests/2.32.3"],
    ["/wp-config.php.bak", "python-requests/2.32.3"],
    ["/", "curl/8.7.1"],
    ["/xmlrpc.php", "Nuclei - Open-source project (github.com/projectdiscovery/nuclei)"],
  ];
  for (const [path, ua] of visits) {
    await request.get(`${WP}${path}`, { headers: { "user-agent": ua }, failOnStatusCode: false, maxRedirects: 0 });
  }

  // The dashboard, signed in from the link, fills in.
  const dash = await page.goto(`${target.baseUrl}/forcefield/dashboard`, { waitUntil: "domcontentloaded" });
  expect(dash?.status()).toBe(200);
  let rows = 0;
  for (let i = 0; i < 20 && rows < 3; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ff-visitors")).toBeVisible({ timeout: 30_000 });
    rows = await page.getByTestId("ff-visitor-row").count();
    if (rows < 3) await page.waitForTimeout(1500);
  }
  expect(rows, "the agents that visited are listed").toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("ff-connection")).toContainText("Connected");
  await expect(page.getByTestId("ff-visitors")).toContainText(/Googlebot|googlebot/);
  await expect(page.getByTestId("ff-visitors")).toContainText("sqlmap");
  await shot(page, "6-dashboard-populated");

  // 7. The server inventory the plugin sent on link, matched on read.
  const panel = page.getByTestId("ff-exposure-report");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const state = await panel.getAttribute("data-state");
  if (EXPECT_EXPOSURE) expect(state, "the panel state for this image's PHP").toBe(EXPECT_EXPOSURE);
  else expect(["exposed", "ok", "unknown"]).toContain(state);
  const php = page.getByTestId("ff-exposure-row").filter({ hasText: "PHP" }).first();
  await expect(php).toBeVisible();
  if (EXPECT_EXPOSURE === "exposed") {
    await expect(php).toHaveAttribute("data-state", "exposed");
    await expect(page.getByTestId("ff-exposure-fix").first()).toContainText("Your hosting company updates PHP");
  }
  await panel.scrollIntoViewIfNeeded();
  await shot(page, `7-server-exposure-${state}`);
  const stats = await page.evaluate(async () => {
    const r = await fetch("/api/forcefield/my-stats", { headers: { "x-forcefield-token": window.localStorage.getItem("ff_dashboard_token") ?? "" } });
    return r.json();
  });
  const exposure = await page.evaluate(async () => {
    const r = await fetch("/api/forcefield/my-exposure", { headers: { "x-forcefield-token": window.localStorage.getItem("ff_dashboard_token") ?? "" } });
    return { status: r.status, body: await r.json() };
  });
  expect(exposure.status).toBe(200);
  writeFileSync(join(PROOF, "tenant.json"), JSON.stringify({ tenantId: stats.tenant.id, site: site(), counts: stats.activity.counts, agents: stats.activity.agents, exposure: exposure.body }, null, 2));
  expect(instinctFailures(), "no CSP violations or JS errors on the Instinct pages").toEqual([]);
});
