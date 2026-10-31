/**
 * Forcefield board - "AI agents reading this site" (/admin/site-analytics), E2E.
 *
 * For one of our own sites: which AI agents and search engines read it, for what
 * purpose, which pages, and whether each was really who it claimed to be. Drives
 * the real page bundle in a real browser with a stubbed session and the board
 * APIs intercepted with fixed data (same pattern as site-analytics-accountable):
 * the cross-site view asks for a site, choosing a site loads its report, an empty
 * report, a failed read, phone width. Asserts HTTP 200 for the page and the APIs,
 * the request carries the chosen site, and no CSP violations or page errors.
 *
 * Fixtures are synthetic: no real IPs, fingerprints or secrets.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/admin/site-analytics";
const INTEL = { triage: false, manageOperators: false, viewIntel: true };

function summary() {
  return {
    rangeDays: 30,
    surfaces: ["ogiam.com", "weekendwithporsche"],
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

const REPORT = {
  sinceIso: "2026-10-01T00:00:00Z",
  days: 30,
  byPurpose: { ai_training: 471, search_engine: 198 },
  agents: [
    { agent: "ClaudeBot", vendor: "Anthropic", purpose: "ai_training", requests: 471, verifiedRequests: 0, impersonations: 0, identity: "unverified", pages: 8, topPages: [{ path: "/", requests: 300 }], daily: [1, 2, 3], lastSeen: null },
    { agent: "Googlebot", vendor: "Google", purpose: "search_engine", requests: 198, verifiedRequests: 43, impersonations: 0, identity: "verified", pages: 8, topPages: [{ path: "/", requests: 120 }], daily: [2, 2, 2], lastSeen: null },
  ],
};

async function stub(page: Page, visibility: { status: number; body: unknown }, policy: { canEdit: boolean } = { canEdit: true }): Promise<{ asked: () => string[]; puts: () => unknown[] }> {
  const asked: string[] = [];
  const puts: unknown[] = [];
  await page.route(/\/api\/admin\/forcefield\/agent-policy/, (route: Route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts.push({ site: new URL(route.request().url()).searchParams.get("site"), ...body });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ blockedAgents: body.blockedAgents }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ blockedAgents: [], choices: ["Bytespider", "ClaudeBot", "GPTBot", "Meta-ExternalAgent"], canEdit: policy.canEdit, updatedAt: null }) });
  });
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: summary(), permissions: INTEL }) }));
  await page.route(/\/api\/admin\/site-analytics\/ai-visibility/, (route: Route) => {
    asked.push(new URL(route.request().url()).searchParams.get("site") ?? "");
    return route.fulfill({ status: visibility.status, contentType: "application/json", body: JSON.stringify(visibility.body) });
  });
  await page.route(/\/api\/admin\/forcefield\/(edge-policy|reputation-optin)/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // The board also loads the selected site's page integrity (its own spec covers it).
  await page.route(/\/api\/admin\/site-analytics\/page-integrity/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrity: { learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } } }) }));
  return { asked: () => asked, puts: () => puts };
}

async function openDefenseTab(page: Page): Promise<void> {
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200 (not 401/blank)`).toBe(200);
  expect((await apiResp).status(), "the board API answers 200").toBe(200);
  await page.getByTestId("tab-forcefield").click();
  await expect(page.getByTestId("admin-ai-visibility-section")).toBeVisible({ timeout: 30_000 });
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

test.describe("Forcefield board: AI agents reading this site", () => {
  test.use({ serviceWorkers: "block" });

  test("the cross-site view asks for a site; choosing one loads that site's report", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const s = await stub(page, { status: 200, body: { visibility: REPORT } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await expect(page.getByTestId("admin-ai-visibility-pick")).toBeVisible();
    expect(s.asked()).toEqual([]);

    const resp = page.waitForResponse((r) => /ai-visibility/.test(r.url()));
    await page.getByTestId("surface-weekendwithporsche").click();
    expect((await resp).status()).toBe(200);
    expect(s.asked()).toEqual(["weekendwithporsche"]);
    await expect(page.getByTestId("admin-ai-visibility")).toBeVisible();
    await expect(page.getByTestId("admin-ai-visibility-purpose-ai_training")).toContainText("AI training: 471 requests");
    await expect(page.locator('[data-agent="ClaudeBot"]')).toContainText("Most read: / (300)");
    await expect(page.locator('[data-agent="Googlebot"]')).toContainText("Verified (43 of 198 checked)");
    expectNoFailures(snapshot);
  });

  test("a site no AI agent has read: an explicit empty state", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { visibility: { ...REPORT, byPurpose: {}, agents: [] } } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-ai-visibility-empty")).toContainText("No AI agents or search engines");
    expectNoFailures(snapshot);
  });

  test("a failed read: a clear error, never a blank panel", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 500, body: { error: "x" } });
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-ai-visibility-error")).toContainText("could not be loaded");
  });

  test("phone width: the report fits, the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { visibility: REPORT } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-weekendwithporsche").click();
    await expect(page.getByTestId("admin-ai-visibility")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
    expectNoFailures(snapshot);
  });

  test("an admin turns an AI training crawler away for the selected site", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const s = await stub(page, { status: 200, body: { visibility: REPORT } }, { canEdit: true });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await openDefenseTab(page);
    await page.getByTestId("surface-weekendwithporsche").click();
    const claude = page.getByTestId("admin-ai-visibility-allow-ClaudeBot");
    await expect(claude).toBeChecked();
    await claude.click();
    await expect(page.getByTestId("admin-ai-visibility-control-status")).toContainText("Saved");
    expect(s.puts()).toEqual([{ site: "weekendwithporsche", blockedAgents: ["ClaudeBot"] }]);
    expectNoFailures(snapshot);
  });

  test("a viewer sees the policy read-only and cannot change it", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const s = await stub(page, { status: 200, body: { visibility: REPORT } }, { canEdit: false });
    await openDefenseTab(page);
    await page.getByTestId("surface-ogiam.com").click();
    await expect(page.getByTestId("admin-ai-visibility-allow-GPTBot")).toBeDisabled();
    await expect(page.getByTestId("admin-ai-visibility-control-status")).toContainText("Only an administrator");
    expect(s.puts()).toEqual([]);
  });
});
