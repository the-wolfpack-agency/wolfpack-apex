/**
 * Forcefield board - "Proven attacks" section (/admin/site-analytics), E2E.
 *
 * The top of the board: per protected site, the blocked payloads and decoy
 * trips (proven hostile), blocked vs report-only, with the control-plane false
 * positive excluded. Drives the real page bundle in a real browser with a
 * stubbed session and the board API intercepted with fixed data (same pattern
 * as site-analytics-defense.spec.ts), so every state is exercised with known
 * data and no database: populated, a site with zero proven events, API 500,
 * reload, and phone width. Asserts HTTP 200 for the page and the board API, and
 * no CSP violations or page errors.
 *
 * Fixtures are synthetic: no real IPs, fingerprints or secrets (public repo).
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/site-analytics-proven.spec.ts
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

async function openBoard(page: Page): Promise<void> {
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200 (not 401/blank)`).toBe(200);
  expect((await apiResp).status(), "the board API answers 200").toBe(200);
  await expect(page.getByTestId("proven-attacks"), "the proven section mounts").toBeVisible({ timeout: 30_000 });
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

test.describe("Forcefield board: proven attacks first", () => {
  // Block the service worker so every request in this file hits the fixture.
  test.use({ serviceWorkers: "block" });

  test("populated: per-site blocked attacks lead the board, noise sits below", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary(), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openBoard(page);

    await expect(page.getByTestId("proven-site-ogiam.com-blocked-count")).toHaveText("158 blocked");
    await expect(page.getByTestId("proven-ogiam.com-blocked-path_traversal")).toContainText("76");
    await expect(page.getByTestId("proven-ogiam.com-blocked-path_traversal-fp")).toHaveText("12");
    await expect(page.getByTestId("proven-ogiam.com-blocked-decoy_trip-fp")).toHaveText("fingerprint not recorded");
    await expect(page.getByTestId("proven-ogiam.com-report-only-xss")).toContainText("3");
    // the false-positive site: zero proven, exclusion stated, not 7,828 attacks
    await expect(page.getByTestId("proven-site-instinct-blocked-count")).toHaveText("0 blocked");
    await expect(page.getByTestId("proven-site-instinct-excluded")).toContainText("7,828");

    // Proven sits above the tabs that hold flagged / welcomed / page views.
    const provenBox = await page.getByTestId("proven-attacks").boundingBox();
    const tabsBox = await page.getByTestId("console-tabs").boundingBox();
    expect(provenBox && tabsBox && provenBox.y < tabsBox.y, "proven attacks render above the noise").toBeTruthy();
    // ...and the noise is still reachable for anyone who looks.
    await expect(page.getByTestId("ff-flagged")).toHaveText("9");
    expectNoFailures(snapshot);
  });

  test("empty site: zero proven events is said plainly, not a healthy zero or a blank", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary({ surface: "weekendwithporsche", proven: { ...proven(), excludedFalsePositives: 0, sites: [proven().sites[2]] } }), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openBoard(page);
    await expect(page.getByTestId("proven-site-weekendwithporsche-empty")).toHaveText(
      "No blocked attacks reported in 30 days. If this site enforces, check that it reports blocks.",
    );
    await expect(page.getByTestId("proven-site-weekendwithporsche-report-only-empty")).toBeVisible();
    await expect(page.getByTestId("proven-weekendwithporsche-blocked-table")).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("proven read failed: explicit error inside the section, rest of the board still renders", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary({ proven: { ...proven(), available: false } }), permissions: INTEL });
    await openBoard(page);
    await expect(page.getByTestId("proven-attacks-error")).toContainText(/could not be loaded/i);
    await expect(page.getByTestId("tab-panel-usage")).toBeVisible();
  });

  test("API 500: an explicit error card, never a blank board", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { error: "boom" }, 500);
    const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
    expect(nav?.status(), "the page itself still answers 200").toBe(200);
    await expect(page.getByTestId("site-analytics-error")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("proven-attacks")).toHaveCount(0);
  });

  test("reload refetches and the proven section renders again", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const board = await stubBoard(page, { summary: summary(), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openBoard(page);
    const before = board.hits();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("proven-site-ogiam.com-blocked-count")).toHaveText("158 blocked", { timeout: 30_000 });
    expect(board.hits()).toBeGreaterThan(before);
    expectNoFailures(snapshot);
  });

  test("phone width: the per-site tables do not push the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubInstinctSession(page, { role: "cto" });
    await stubBoard(page, { summary: summary(), permissions: INTEL });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openBoard(page);
    await expect(page.getByTestId("proven-ogiam.com-blocked-table")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
    expectNoFailures(snapshot);
  });

  test("viewer without forcefield.view: the gated card, no per-site breakdown", async ({ page }) => {
    await stubInstinctSession(page, { role: "member" });
    const s = summary();
    delete (s as Record<string, unknown>).proven;
    await stubBoard(page, { summary: s, permissions: { triage: false, manageOperators: false, viewIntel: false } });
    await openBoard(page);
    await expect(page.getByTestId("proven-attacks-gated")).toContainText("158 requests blocked");
    await expect(page.getByTestId("proven-site-ogiam.com")).toHaveCount(0);
  });
});
