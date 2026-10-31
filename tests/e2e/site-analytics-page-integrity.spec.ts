/**
 * Forcefield board - "Page integrity" (/admin/site-analytics), E2E.
 *
 * For one of our own sites: which origins visitors' browsers saw its pages load
 * that the site never uses, whether each is new since the 7-day baseline, and
 * whether a new one reaches enough visitors to be worth checking. Drives the real
 * page bundle in a real browser with a stubbed session and the board APIs
 * intercepted with fixed data (same pattern as site-analytics-ai-visibility):
 * the cross-site view asks for a site, the learning state, a new origin for many
 * visitors, the empty state, a failed read, phone width. Asserts HTTP 200 for the
 * page and the APIs, the request carries the chosen site, and no CSP violations
 * or page errors.
 *
 * Fixtures are synthetic: example.com origins, no real visitors or secrets.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/admin/site-analytics";
const INTEL = { triage: false, manageOperators: false, viewIntel: true };
const DAY = 86400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function summary() {
  return {
    rangeDays: 30,
    surfaces: ["ogiam.com", "aidanmulready"],
    surface: "all",
    totalPageViews: 10, collectsPageViews: true, totalEvents: 20,
    byHour: [], byPage: [], byCountry: [], byType: [],
    forcefield: { welcomed: 5, flagged: 0, trapped: 0, blocked: 0, wouldBlock: 0, hostileOperators: 0, hostileEvents: 0, topAgents: [] },
    learnedSignatures: { shadow: 0, enforcing: 0, autoBlocked: 0 },
    agentIntel: { operators: 0, campaigns: 0, automationFleet: 0, aiAgents: 0, scripts: 0, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] },
    journeys: [], agentOrigins: [], probeIntel: [], payloadIntel: [], operatorTriage: {}, blockedOperators: [],
    networkReputation: {}, networkTradecraft: [], principalByOperator: {}, verdictFeedback: { falsePositives: 0 },
  };
}

const origin = (o: Record<string, unknown>) => ({
  directive: "script-src", origin: "https://cdn.example.com", status: "baseline", wouldAlert: false,
  firstSeen: new Date(T0).toISOString(), lastSeen: new Date(T0 + 9 * DAY).toISOString(),
  reports: 40, sessions: 30, pages: 6, sessions24h: 4, pages24h: 3, topPage: "/", ...o,
});
const learning = (active: boolean) => ({ startedAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 7 * DAY).toISOString(), active });

const LEARNING = { learning: learning(true), origins: [origin({})], totals: { origins: 1, newOrigins: 0, wouldAlert: 0 } };
const TAMPERED = {
  learning: learning(false),
  origins: [
    origin({ directive: "connect-src", origin: "https://collect.example.net", status: "new", wouldAlert: true, firstSeen: new Date(T0 + 9 * DAY).toISOString(), sessions: 12, pages: 3, sessions24h: 12, pages24h: 3, topPage: "/checkout" }),
    origin({}),
  ],
  totals: { origins: 2, newOrigins: 1, wouldAlert: 1 },
};
const EMPTY = { learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } };

async function stub(page: Page, integrity: { status: number; body: unknown }): Promise<{ asked: () => string[] }> {
  const asked: string[] = [];
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: summary(), permissions: INTEL }) }));
  await page.route(/\/api\/admin\/site-analytics\/page-integrity/, (route: Route) => {
    asked.push(new URL(route.request().url()).searchParams.get("site") ?? "");
    return route.fulfill({ status: integrity.status, contentType: "application/json", body: JSON.stringify(integrity.body) });
  });
  await page.route(/\/api\/admin\/site-analytics\/ai-visibility/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ visibility: { sinceIso: "2026-10-01T00:00:00Z", days: 30, byPurpose: {}, agents: [] } }) }));
  await page.route(/\/api\/admin\/forcefield\/(agent-policy|edge-policy|reputation-optin)/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  return { asked: () => asked };
}

async function openDefenseTab(page: Page): Promise<void> {
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200 (not 401/blank)`).toBe(200);
  expect((await apiResp).status(), "the board API answers 200").toBe(200);
  await page.getByTestId("tab-forcefield").click();
  await expect(page.getByTestId("admin-page-integrity-section")).toBeVisible({ timeout: 30_000 });
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

test.describe("Forcefield board: page integrity", () => {
  test.use({ serviceWorkers: "block" });

  test("the cross-site view asks for a site; choosing one shows its learning baseline", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const s = await stub(page, { status: 200, body: { integrity: LEARNING } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await expect(page.getByTestId("admin-page-integrity-pick")).toBeVisible();
    expect(s.asked()).toEqual([]);

    const resp = page.waitForResponse((r) => /page-integrity/.test(r.url()));
    await page.getByTestId("surface-aidanmulready").click();
    expect((await resp).status()).toBe(200);
    // Every read carries the chosen site (a dev-server recompile can remount the
    // panel and repeat the read; the count is not the contract, the scope is).
    expect(s.asked().length).toBeGreaterThan(0);
    expect(new Set(s.asked())).toEqual(new Set(["aidanmulready"]));
    await expect(page.getByTestId("admin-page-integrity-learning")).toContainText("Learning what your pages normally load");
    await expect(page.getByTestId("admin-page-integrity-row-0")).toContainText("Runs a script from https://cdn.example.com");
    expectNoFailures(snapshot);
  });

  test("a new origin reaching many visitors leads, in plain words", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { integrity: TAMPERED } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-page-integrity-headline")).toContainText("1 new place is reaching many of your visitors");
    await expect(page.getByTestId("admin-page-integrity-row-0")).toContainText("Sends data to https://collect.example.net");
    await expect(page.getByTestId("admin-page-integrity-row-0")).toContainText("most often on /checkout");
    await expect(page.getByTestId("admin-page-integrity-status-0")).toContainText("New, many visitors");
    await expect(page.getByTestId("admin-page-integrity-status-1")).toContainText("Seen in the baseline");
    expectNoFailures(snapshot);
  });

  test("a site with no reports yet: an explicit empty state", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { integrity: EMPTY } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-page-integrity-empty")).toContainText("No reports yet");
    expectNoFailures(snapshot);
  });

  test("a failed read: a clear error, never a blank panel", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 500, body: { error: "x" } });
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-page-integrity-error")).toContainText("could not be loaded");
  });

  test("phone width: the report fits, the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { integrity: TAMPERED } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-page-integrity")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
    expectNoFailures(snapshot);
  });
});
