/**
 * Forcefield self-serve onboarding E2E: the whole journey a person takes, in a
 * real browser, against the built pages.
 *
 *   /forcefield/signup      enter site + Wolfpack alert address -> the install
 *                           step -> continue with a DNS record / file
 *   /forcefield/setup       prove ownership (a failed check explains itself,
 *                           then the check passes), connect (no-code marked
 *                           coming soon, concierge, the quick-start), the
 *                           confirmation email is pending; reload resumes
 *   /forcefield/confirm     one click confirms the address (nothing on load)
 *   /forcefield/dashboard   alerts on for the address; change it
 *   /forcefield/unsubscribe one click stops email
 *
 * STUBBED SESSION: every /api/forcefield/* call is answered by an in-test stub
 * that keeps the onboarding state (setup key, verified, tenant token, address
 * status), so the run is deterministic, creates no rows, provisions no tenant
 * and sends no email. Only a Wolfpack test address (thewolfpack.agency) is
 * used. Each step asserts the page answered 200, the key widget rendered, and
 * no CSP violation or JS error occurred; a mobile-width pass asserts no
 * horizontal scroll on the setup page.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SITE = "e2e-onboarding.thewolfpack.agency";
const EMAIL = "forcefield-e2e@thewolfpack.agency";
const NEW_EMAIL = "forcefield-e2e-2@thewolfpack.agency";
const SETUP_KEY = "ffs_e2e_setup_key";
const TOKEN = "ff_e2e_tenant_token";

interface Stub {
  verifyCalls: number;
  verified: boolean;
  concierge: boolean;
  notifyEmail: string | null;
  notifyStatus: "pending" | "confirmed" | "unsubscribed" | null;
  confirmPosts: number;
  unsubPosts: number;
  puts: string[];
}

const QUICKSTART = {
  connector: { key: "generic", title: "Other / any stack", managed: false, emits: { next: true, cloudflare: true }, steps: ["Pick the adapter closest to your stack."] },
  cloudflareEnv: { FORCEFIELD_SITE: SITE, SITE_ANALYTICS_INGEST_TOKEN: TOKEN, FORCEFIELD_ENFORCE: "off" },
  nextEnv: { FORCEFIELD_SITE: SITE, FORCEFIELD_EDGE_TOKEN: TOKEN },
  nextSnippet: "export async function middleware() { /* forcefield */ }",
};

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubApi(page: Page, s: Stub) {
  const state = () => ({
    requestId: "req-e2e", site: SITE, email: EMAIL, step: s.verified ? "connect" : "verify",
    ownership: s.verified
      ? { verified: true, method: "dns_txt", verifiedAt: "2026-10-26T12:00:00Z", instructions: [] }
      : { verified: false, method: null, verifiedAt: null, instructions: [
          { method: "dns_txt", summary: "", location: SITE, value: "ogiam-site-verification=e2echallenge" },
          { method: "http_well_known", summary: "", location: `https://${SITE}/.well-known/ogiam-site-verification.txt`, value: "e2echallenge" },
        ] },
    tenant: s.verified ? { id: "t-e2e", siteLabel: SITE } : null,
    connection: s.verified ? { connected: false, everConnected: false, lastEventAt: null } : null,
    notify: s.verified ? { email: s.notifyEmail, status: s.notifyStatus, confirmedAt: null } : null,
    conciergeRequested: s.concierge,
  });

  await page.route(/\/api\/forcefield\/onboarding$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { siteUrl: string; email: string };
      expect(body.email.endsWith("@thewolfpack.agency")).toBe(true);
      return json(route, 201, { ok: true, mode: "self_serve", requestId: "req-e2e", setupKey: SETUP_KEY, site: SITE, email: EMAIL, ownership: state().ownership.instructions });
    }
    if (req.headers()["x-forcefield-setup"] !== SETUP_KEY) return json(route, 401, { ok: false, error: "unauthorized" });
    return json(route, 200, { ok: true, state: state() });
  });
  await page.route(/\/api\/forcefield\/onboarding\/verify$/, async (route) => {
    if (route.request().headers()["x-forcefield-setup"] !== SETUP_KEY) return json(route, 401, { ok: false });
    s.verifyCalls++;
    if (s.verifyCalls === 1) {
      return json(route, 422, { ok: false, error: "not_verified", attempts: [{ method: "dns_txt", reason: "no_txt_record" }, { method: "http_well_known", reason: "http_404" }] });
    }
    s.verified = true;
    s.notifyEmail = EMAIL;
    s.notifyStatus = "pending";
    return json(route, 200, { ok: true, tenant: { id: "t-e2e", name: SITE, siteLabel: SITE }, token: TOKEN, quickstart: QUICKSTART, method: "dns_txt", notify: { status: "pending", delivered: true, reason: "ok" } });
  });
  await page.route(/\/api\/forcefield\/onboarding\/concierge$/, async (route) => {
    s.concierge = true;
    return json(route, 200, { ok: true });
  });
  await page.route(/\/api\/forcefield\/my-setup$/, async (route) => {
    if (route.request().headers()["x-forcefield-token"] !== TOKEN) return json(route, 401, { ok: false });
    return json(route, 200, { ok: true, tenant: { id: "t-e2e", name: SITE, siteLabel: SITE }, quickstart: QUICKSTART, connection: { connected: false, everConnected: false, lastEventAt: null } });
  });
  await page.route(/\/api\/forcefield\/my-stats$/, async (route) => {
    if (route.request().headers()["x-forcefield-token"] !== TOKEN) return json(route, 401, { ok: false });
    return json(route, 200, { ok: true, tenant: { id: "t-e2e", name: SITE, siteLabel: SITE }, stats: { rangeDays: 30, agentsDetected: 0, welcomed: 0, trapped: 0, probed: 0, payloads: 0, hostile: 0, sitesProtected: 1, attacks: [] } });
  });
  await page.route(/\/api\/forcefield\/my-exposure$/, async (route) => {
    if (route.request().headers()["x-forcefield-token"] !== TOKEN) return json(route, 401, { ok: false });
    return json(route, 200, { ok: true, report: null }); // the server check panel's empty state
  });
  await page.route(/\/api\/forcefield\/alert-email$/, async (route) => {
    const req = route.request();
    if (req.headers()["x-forcefield-token"] !== TOKEN) return json(route, 401, { ok: false });
    if (req.method() === "PUT") {
      const { email } = req.postDataJSON() as { email: string };
      s.puts.push(email);
      if (!email.endsWith("@thewolfpack.agency")) return json(route, 403, { ok: false, error: "not_allowed" });
      s.notifyEmail = email;
      s.notifyStatus = "pending";
      return json(route, 200, { ok: true, status: "pending", delivered: true });
    }
    if (req.method() === "DELETE") { s.notifyEmail = null; s.notifyStatus = null; return json(route, 200, { ok: true }); }
    return json(route, 200, { ok: true, notify: { email: s.notifyEmail, status: s.notifyStatus, confirmedAt: null, restricted: true } });
  });
  await page.route(/\/api\/forcefield\/alert-email\/confirm$/, async (route) => {
    s.confirmPosts++;
    const { token } = route.request().postDataJSON() as { token: string };
    if (token !== "e2e-confirm-token") return json(route, 400, { ok: false, error: "invalid" });
    s.notifyStatus = "confirmed";
    return json(route, 200, { ok: true, site: SITE });
  });
  await page.route(/\/api\/forcefield\/alert-email\/unsubscribe$/, async (route) => {
    s.unsubPosts++;
    s.notifyStatus = "unsubscribed";
    return json(route, 200, { ok: true, site: SITE });
  });
}

async function open(page: Page, path: string) {
  const res = await page.goto(`${target.baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(res?.status(), `${path} answers 200`).toBe(200);
}

const freshStub = (): Stub => ({ verifyCalls: 0, verified: false, concierge: false, notifyEmail: null, notifyStatus: null, confirmPosts: 0, unsubPosts: 0, puts: [] });

test.describe("Forcefield self-serve onboarding", () => {
  test("site + email -> ownership -> connect -> confirm -> dashboard -> unsubscribe", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    const s = freshStub();
    await stubApi(page, s);

    // Step 1: site + alert address.
    await open(page, "/forcefield/signup");
    await expect(page.getByTestId("ff-s-submit")).toBeDisabled(); // both fields required
    await page.getByTestId("ff-s-site").fill(SITE);
    await page.getByTestId("ff-s-email").fill(EMAIL);
    await expect(page.getByTestId("ff-s-submit")).toBeEnabled();
    await page.getByTestId("ff-s-submit").click();
    // Step 2 on the signup page: the install option (no platform found -> concierge),
    // with the DNS / file path one click away.
    await expect(page.getByTestId("ff-install")).toBeVisible();
    await page.getByTestId("ff-install-setup").click();
    await expect(page).toHaveURL(/\/forcefield\/setup$/);

    // Step 2: both proofs shown with exact values; a failed check explains itself.
    await expect(page.getByTestId("ff-setup-site")).toHaveText(SITE);
    await expect(page.getByTestId("ff-dns-value")).toHaveText("ogiam-site-verification=e2echallenge");
    await expect(page.getByTestId("ff-file-url")).toHaveText(`https://${SITE}/.well-known/ogiam-site-verification.txt`);
    await page.getByTestId("ff-verify").click();
    await expect(page.getByTestId("ff-verify-error")).toContainText("DNS record: no TXT record found yet");
    await page.getByTestId("ff-verify").click();
    await expect(page.getByTestId("ff-verified")).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("ff_dashboard_token"))).toBe(TOKEN);

    // Step 3: connect. No-code is marked coming soon; concierge + the quick-start work.
    await expect(page.getByTestId("ff-nocode")).toContainText(/Coming soon/);
    await page.getByTestId("ff-diy").locator("summary").click();
    await expect(page.getByTestId("ff-diy-cf")).toContainText(`SITE_ANALYTICS_INGEST_TOKEN=${TOKEN}`);
    await page.getByTestId("ff-concierge").click();
    await expect(page.getByTestId("ff-concierge-done")).toBeVisible();

    // Step 4: confirmation pending; resend works.
    await expect(page.getByTestId("ff-email-pending")).toContainText(EMAIL);
    await page.getByTestId("ff-email-resend").click();
    await expect(page.getByTestId("ff-email-resent")).toBeVisible();
    expect(s.puts).toEqual([EMAIL]);

    // Reload resumes where the person left off.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ff-verified")).toBeVisible();
    await expect(page.getByTestId("ff-concierge-done")).toBeVisible();

    // The emailed link: nothing happens on load, one click confirms.
    await open(page, "/forcefield/confirm?token=e2e-confirm-token");
    await expect(page.getByTestId("ff-confirm-button")).toBeVisible();
    expect(s.confirmPosts).toBe(0);
    await page.getByTestId("ff-confirm-button").click();
    await expect(page.getByTestId("ff-confirm-done")).toContainText(SITE);

    // Back on setup, step 4 is done.
    await open(page, "/forcefield/setup");
    await expect(page.getByTestId("ff-email-confirmed")).toContainText(EMAIL);

    // Dashboard: connected with the stored token, alerts on, change the address.
    await open(page, "/forcefield/dashboard");
    await expect(page.getByTestId("ff-stats")).toBeVisible();
    await expect(page.getByTestId("ff-attacks-empty")).toBeVisible();
    await expect(page.getByTestId("ff-alert-status")).toContainText("Alerts on");
    await page.getByTestId("ff-alert-change").click();
    await page.getByTestId("ff-alert-input").fill(NEW_EMAIL);
    await page.getByTestId("ff-alert-save").click();
    await expect(page.getByTestId("ff-alert-message")).toContainText(`Confirmation email sent to ${NEW_EMAIL}`);
    await expect(page.getByTestId("ff-alert-status")).toContainText("Waiting for confirmation");

    // The unsubscribe link in every email: one click.
    await open(page, "/forcefield/unsubscribe?token=e2e-unsub-token");
    expect(s.unsubPosts).toBe(0);
    await page.getByTestId("ff-unsub-button").click();
    await expect(page.getByTestId("ff-unsub-done")).toContainText(SITE);

    // No admin links anywhere on the client pages.
    expect(await page.locator('a[href^="/admin"]').count()).toBe(0);
    expect(getFailures().filter((f) => f.kind === "console"), "no CSP violations or JS errors").toEqual([]);
    // The only non-2xx calls in the journey are the expected 422 on the first check.
    expect(getFailures().filter((f) => f.kind === "network")).toEqual([]);
  });

  test("setup without a key explains how to start (no blank page)", async ({ page }) => {
    const getFailures = collectConsoleAndNetworkFailures(page);
    await stubApi(page, freshStub());
    await open(page, "/forcefield/setup");
    await expect(page.getByTestId("ff-setup-missing")).toBeVisible();
    await expect(page.getByTestId("ff-setup-missing").locator('a[href="/forcefield/signup"]')).toBeVisible();
    expect(getFailures(), "no CSP violations, JS errors or failed calls").toEqual([]);
  });

  test("mobile: the setup page fits the screen with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const getFailures = collectConsoleAndNetworkFailures(page);
    await stubApi(page, freshStub());
    await open(page, "/forcefield/setup");
    await page.evaluate(([k, v]) => window.localStorage.setItem(k, v), ["ff_setup_key", SETUP_KEY]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ff-dns-value")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(getFailures().filter((f) => f.kind === "console")).toEqual([]);
  });
});
