/**
 * Forcefield board - "Actions need a person" tile (/admin/site-analytics), E2E.
 *
 * Watch mode: per protected site, how many state-changing requests came from a
 * browser session, a signed agent in or out of its mandate, or unaccountable
 * automation, and how many "hold for review" would have held. Drives the real
 * page bundle in a real browser with a stubbed session and the board API
 * intercepted with fixed data (same pattern as site-analytics-proven.spec.ts):
 * populated, empty window, read failed, older API without the field, reload,
 * phone width, and a viewer without forcefield.view. Asserts HTTP 200 for the
 * page and the board API, and no CSP violations or page errors.
 *
 * Fixtures are synthetic: no real IPs, principals, fingerprints or secrets.
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/site-analytics-accountable.spec.ts
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/admin/site-analytics";
const INTEL = { triage: false, manageOperators: false, viewIntel: true };

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
const emptyMode = () => ({ events: 0, fingerprints: null, withoutFingerprint: 0, lastSeen: null, byClass: [] });

function proven() {
  return {
    available: true,
    generatedAt: iso(0),
    excludedFalsePositives: 7828,
    sites: [
      {
        site: "ogiam.com", lastReportAt: iso(0.5), excludedFalsePositives: 0,
        blocked: {
          events: 158, fingerprints: 12, withoutFingerprint: 82, lastSeen: iso(2),
          byClass: [
            { attack: "decoy_trip", eventType: "site.agent_trap_tripped", count: 82, fingerprints: null, withoutFingerprint: 82, lastSeen: iso(20) },
            { attack: "path_traversal", eventType: "site.agent_payload_attack", count: 76, fingerprints: 12, withoutFingerprint: 0, lastSeen: iso(2) },
          ],
        },
        reportOnly: {
          events: 3, fingerprints: 2, withoutFingerprint: 0, lastSeen: iso(30),
          byClass: [{ attack: "xss", eventType: "site.agent_payload_attack", count: 3, fingerprints: 2, withoutFingerprint: 0, lastSeen: iso(30) }],
        },
      },
      { site: "instinct", lastReportAt: iso(0.1), excludedFalsePositives: 7828, blocked: emptyMode(), reportOnly: emptyMode() },
      { site: "weekendwithporsche", lastReportAt: iso(1), excludedFalsePositives: 0, blocked: emptyMode(), reportOnly: emptyMode() },
    ],
  };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    rangeDays: 30,
    surfaces: ["instinct", "ogiam.com", "weekendwithporsche"],
    surface: "all",
    totalPageViews: 120,
    collectsPageViews: true,
    totalEvents: 400,
    byHour: [{ hour: 9, count: 12 }],
    byPage: [{ path: "/", count: 120 }],
    byCountry: [{ country: "US", count: 100 }],
    byType: [{ type: "site.page_viewed", count: 120 }],
    forcefield: { welcomed: 5, flagged: 9, trapped: 82, blocked: 158, wouldBlock: 3, hostileOperators: 2, hostileEvents: 6, topAgents: [{ agent: "GPTBot", count: 5 }] },
    learnedSignatures: { shadow: 0, enforcing: 0, autoBlocked: 0 },
    agentIntel: { operators: 0, campaigns: 0, automationFleet: 0, aiAgents: 0, scripts: 0, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] },
    journeys: [],
    agentOrigins: [],
    probeIntel: [],
    payloadIntel: [{ attack: "path_traversal", count: 76 }],
    operatorTriage: {},
    blockedOperators: [],
    networkReputation: {},
    networkTradecraft: [],
    principalByOperator: {},
    verdictFeedback: { falsePositives: 0 },
    proven: proven(),
    ...over,
  };
}

function accountability(over: Record<string, unknown> = {}) {
  return {
    available: true,
    rangeDays: 30,
    surface: "all",
    totals: { total: 46, browserSession: 40, signedWithin: 2, signedOutside: 1, unaccountable: 3, wouldHold: 4 },
    sites: [
      { site: "instinct", total: 43, browserSession: 40, signedWithin: 0, signedOutside: 0, unaccountable: 3, wouldHold: 3 },
      { site: "ogiam.com", total: 3, browserSession: 0, signedWithin: 2, signedOutside: 1, unaccountable: 0, wouldHold: 1 },
    ],
    heldReasons: [{ reason: "script_client", count: 3 }, { reason: "verified_principal", count: 1 }],
    kinds: [{ kind: "login", count: 30, wouldHold: 2 }],
    ...over,
  };
}

async function stubBoard(page: Page, body: unknown, status = 200): Promise<{ hits: () => number }> {
  let hits = 0;
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, async (route: Route) => {
    hits++;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(/\/api\/admin\/forcefield\/(edge-policy|reputation-optin)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return { hits: () => hits };
}

async function openDefenseTab(page: Page): Promise<void> {
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200 (not 401/blank)`).toBe(200);
  expect((await apiResp).status(), "the board API answers 200").toBe(200);
  await page.getByTestId("tab-forcefield").click();
  await expect(page.getByTestId("ff-accountable"), "the tile mounts").toBeVisible({ timeout: 30_000 });
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

test.describe("Forcefield board: actions need a person (watch mode)", () => {
  test.use({ serviceWorkers: "block" });

  test("populated: per-site classes and would-hold counts render", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary({ accountability: accountability() }), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await expect(page.getByTestId("ff-accountable-total")).toHaveText("46");
    await expect(page.getByTestId("ff-accountable-would-hold")).toHaveText("4");
    await expect(page.getByTestId("ff-accountable-site-ogiam.com")).toContainText("ogiam.com");
    const cells = await page.getByTestId("ff-accountable-site-ogiam.com").locator("td").allTextContents();
    expect(cells).toEqual(["ogiam.com", "0", "2", "1", "0", "1"]);
    await expect(page.getByTestId("ff-accountable-reason-verified_principal")).toContainText("outside its mandate");
    await expect(page.getByTestId("ff-accountable")).toContainText("never held");
    expectNoFailures(snapshot);
  });

  test("empty window: an explicit empty state, not a blank or a zero table", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const empty = accountability({ totals: { total: 0, browserSession: 0, signedWithin: 0, signedOutside: 0, unaccountable: 0, wouldHold: 0 }, sites: [], heldReasons: [], kinds: [] });
    await stubBoard(page, { summary: summary({ accountability: empty }), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await expect(page.getByTestId("ff-accountable-empty")).toContainText("No state-changing requests");
    await expect(page.getByTestId("ff-accountable-table")).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("read failed, or an older API without the field: an error, never a zero", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary({ accountability: accountability({ available: false }) }), permissions: INTEL });
    await openDefenseTab(page);
    await expect(page.getByTestId("ff-accountable-error")).toContainText("unknown, not zero");
    await expect(page.getByTestId("ff-accountable-total")).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary(), permissions: INTEL });
    await openDefenseTab(page);
    await expect(page.getByTestId("ff-accountable-error")).toBeVisible();
  });

  test("reload refetches and the tile renders again", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const board = await stubBoard(page, { summary: summary({ accountability: accountability() }), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    const before = board.hits();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("tab-forcefield").click();
    await expect(page.getByTestId("ff-accountable-total")).toHaveText("46", { timeout: 30_000 });
    expect(board.hits()).toBeGreaterThan(before);
    expectNoFailures(snapshot);
  });

  test("phone width: the per-site table scrolls inside the tile, the page does not", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary({ accountability: accountability() }), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await expect(page.getByTestId("ff-accountable-table")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
    expectNoFailures(snapshot);
  });

  test("viewer without forcefield.view: no defense tab, no tile", async ({ page }) => {
    await stubInstinctSession(page, { role: "member" });
    const s = summary();
    delete (s as Record<string, unknown>).proven;
    await stubBoard(page, { summary: s, permissions: { triage: false, manageOperators: false, viewIntel: false } });
    const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(nav?.status()).toBe(200);
    await expect(page.getByTestId("tab-usage")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tab-forcefield")).toHaveCount(0);
    await expect(page.getByTestId("ff-accountable")).toHaveCount(0);
  });
});
