/**
 * Forcefield board - "What the edge did" panel (/admin/site-analytics), E2E.
 *
 * Two layers, both in a real browser against the real page bundle:
 *
 *  A. DETERMINISTIC (always runs): a stubbed session plus the board API
 *     intercepted with a fixed summary, so every state is exercised with known
 *     data and no database: populated, empty, API error, viewer without the
 *     intel capability, reload, and a phone-width viewport. Asserts HTTP 200 for
 *     the page and its API, no CSP violations or page errors, and that every
 *     widget renders real content or its explicit empty state.
 *
 *  B. LIVE (runs when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are set): real
 *     sign-in, the real /api/admin/site-analytics response (200 + a defense
 *     block for intel holders), and the panel rendering content or its honest
 *     empty state. Fails loudly in CI if the creds are configured but sign-in
 *     does not work, like the sibling live spec.
 *
 * Run locally (no DB needed for A). Use a production build: in dev mode the
 * CSP (no unsafe-eval) stops the dev bundle from hydrating.
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/site-analytics-defense.spec.ts
 * Against a deployment: PROD_URL=<url> SMOKE_TEST_EMAIL=... SMOKE_TEST_PASSWORD=... npx playwright test <this file>
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const PATH = "/admin/site-analytics";
const INTEL = { triage: false, manageOperators: false, viewIntel: true };

const DEFENSE = {
  enforcement: { blocked: 7, wouldBlock: 3, byReason: [{ reason: "payload", blocked: 5, wouldBlock: 1 }, { reason: "attack_tool", blocked: 0, wouldBlock: 2 }, { reason: "decoy", blocked: 2, wouldBlock: 0 }] },
  highRate: { bursts: 4, operators: 2, peakRate: 88, windowSeconds: 10, fromIngest: 1 },
  identity: { verified: 12, impersonation: 3, unverifiable: 2, signed: 1, byAgent: [{ agent: "GPTBot", verified: 12, impersonation: 3, unverifiable: 0, signed: 0 }, { agent: "Claude-User", verified: 0, impersonation: 0, unverifiable: 2, signed: 1 }] },
  probes: [{ probe: "next_server_action", count: 6 }],
  networks: [{ asn: "16509", org: "AMAZON-02", count: 40, hostile: 11 }],
};

function summary(over: Record<string, unknown> = {}) {
  return {
    rangeDays: 30,
    surfaces: ["ogiam.com"],
    surface: "all",
    totalPageViews: 120,
    collectsPageViews: true,
    totalEvents: 400,
    byHour: [{ hour: 9, count: 12 }],
    byPage: [{ path: "/", count: 120 }],
    byCountry: [{ country: "US", count: 100 }],
    byType: [{ type: "site.page_viewed", count: 120 }],
    forcefield: { welcomed: 5, flagged: 9, trapped: 1, blocked: 7, wouldBlock: 3, hostileOperators: 2, hostileEvents: 6, topAgents: [{ agent: "GPTBot", count: 5 }] },
    learnedSignatures: { shadow: 0, enforcing: 0, autoBlocked: 0 },
    agentIntel: { operators: 9, campaigns: 0, automationFleet: 1, aiAgents: 3, scripts: 1, scanners: 2, impersonators: 1, verifiedAgents: 2, datacenterOperators: 1, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] },
    journeys: [],
    agentOrigins: [],
    probeIntel: [],
    payloadIntel: [{ attack: "nextjs_middleware_bypass", count: 4 }, { attack: "php_cgi_injection", count: 2 }],
    operatorTriage: {},
    blockedOperators: [],
    networkReputation: {},
    networkTradecraft: [],
    principalByOperator: {},
    verdictFeedback: { falsePositives: 0 },
    defense: DEFENSE,
    ...over,
  };
}

const EMPTY_DEFENSE = {
  enforcement: { blocked: 0, wouldBlock: 0, byReason: [] },
  highRate: { bursts: 0, operators: 0, peakRate: 0, windowSeconds: null, fromIngest: 0 },
  identity: { verified: 0, impersonation: 0, unverifiable: 0, signed: 0, byAgent: [] },
  probes: [],
  networks: [],
};

/** Intercept the board API (and the two side reads it makes) with fixed data.
 *  Returns a counter of board API hits so a test can assert the reload refetched. */
async function stubBoard(page: Page, body: unknown, status = 200): Promise<{ hits: () => number }> {
  let hits = 0;
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, async (route: Route) => {
    hits++;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  // The edge-policy / reputation side reads: a viewer without the manage
  // capability gets nothing back, which the page treats as "not shown".
  await page.route(/\/api\/admin\/forcefield\/(edge-policy|reputation-optin)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return { hits: () => hits };
}

async function openDefense(page: Page): Promise<void> {
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
  const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), `${PATH} loads 200 (not 401/blank)`).toBe(200);
  expect((await apiResp).status(), "the board API answers 200").toBe(200);
  await expect(page.getByTestId("site-analytics-page"), "the board shell mounts").toBeVisible({ timeout: 30_000 });
  await page.getByTestId("tab-forcefield").click();
  await expect(page.getByTestId("tab-panel-forcefield")).toBeVisible();
  await expect(page.getByTestId("ff-defense"), "the defense panel renders").toBeVisible();
}

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

test.describe("Forcefield board: what the edge did", () => {
  test("unauthenticated visit redirects to /login (never a blank admin page)", async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe("/login");
    } finally {
      await ctx.close();
    }
  });

  test.describe("deterministic (stubbed session + fixed board data)", () => {
    // The app registers a service worker; once it controls the page (after the
    // first load) its fetches bypass page.route, so a reload would hit the real
    // API. Block it so every request in this block is the fixed fixture.
    test.use({ serviceWorkers: "block" });
    test("populated: every widget shows real content, no CSP violations", async ({ page }) => {
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { summary: summary(), permissions: INTEL });
      const snapshot = collectConsoleAndNetworkFailures(page);
      await openDefense(page);

      await expect(page.getByTestId("ff-defense-blocked")).toHaveText("7");
      await expect(page.getByTestId("ff-defense-would-block")).toHaveText("3");
      await expect(page.getByTestId("ff-defense-reason-attack_tool")).toContainText("2 would block");
      await expect(page.getByTestId("ff-defense-payload-nextjs_middleware_bypass")).toContainText("Next.js middleware bypass");
      await expect(page.getByTestId("ff-defense-payload-php_cgi_injection")).toContainText("PHP-CGI argument injection");
      await expect(page.getByTestId("ff-defense-peak")).toContainText("88 requests in 10s");
      await expect(page.getByTestId("ff-defense-impersonation")).toContainText("3");
      await expect(page.getByTestId("ff-defense-signed")).toContainText("1");
      await expect(page.getByTestId("ff-defense-agent-GPTBot")).toContainText("GPTBot");
      await expect(page.getByTestId("ff-defense-probe-next_server_action")).toContainText("Next.js server action probe");
      await expect(page.getByTestId("ff-defense-asn-16509")).toContainText("AMAZON-02");
      await expect(page.getByTestId("ff-defense-operator-mix")).toContainText("1 impersonator");
      expectNoFailures(snapshot);
    });

    test("empty window: the explicit empty state, not zeros", async ({ page }) => {
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { summary: summary({ defense: EMPTY_DEFENSE, payloadIntel: [], agentIntel: { operators: 0, campaigns: 0, automationFleet: 0, aiAgents: 0, scripts: 0, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] } }), permissions: INTEL });
      const snapshot = collectConsoleAndNetworkFailures(page);
      await openDefense(page);
      await expect(page.getByTestId("ff-defense-empty")).toContainText(/nothing blocked/i);
      await expect(page.getByTestId("ff-defense-blocked")).toHaveCount(0);
      expectNoFailures(snapshot);
    });

    test("partial data: each empty section says so", async ({ page }) => {
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { summary: summary({ payloadIntel: [], defense: { ...EMPTY_DEFENSE, enforcement: DEFENSE.enforcement } }), permissions: INTEL });
      await openDefense(page);
      await expect(page.getByTestId("ff-defense-payloads-empty")).toBeVisible();
      await expect(page.getByTestId("ff-defense-rate-empty")).toBeVisible();
      await expect(page.getByTestId("ff-defense-identity-empty")).toBeVisible();
      await expect(page.getByTestId("ff-defense-networks-empty")).toContainText(/Cloudflare/);
    });

    test("API error: an explicit error card, never a blank board", async ({ page }) => {
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { error: "boom" }, 500);
      await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("site-analytics-error")).toBeVisible({ timeout: 30_000 });
    });

    test("viewer without forcefield.view: no Agent defense tab, usage still renders", async ({ page }) => {
      await stubInstinctSession(page, { role: "member" });
      await stubBoard(page, { summary: summary(), permissions: { triage: false, manageOperators: false, viewIntel: false } });
      const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded" });
      expect(nav?.status()).toBe(200);
      await expect(page.getByTestId("tab-panel-usage")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("tab-forcefield")).toHaveCount(0);
      await expect(page.getByTestId("ff-defense")).toHaveCount(0);
    });

    test("reload refetches and the panel renders again", async ({ page }) => {
      await stubInstinctSession(page, { role: "cto" });
      const board = await stubBoard(page, { summary: summary(), permissions: INTEL });
      await openDefense(page);
      const before = board.hits();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("site-analytics-page")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("tab-forcefield").click();
      await expect(page.getByTestId("ff-defense-blocked")).toHaveText("7");
      expect(board.hits()).toBeGreaterThan(before);
    });

    test("phone width: the panel renders without pushing the page sideways", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { summary: summary(), permissions: INTEL });
      await openDefense(page);
      await expect(page.getByTestId("ff-defense-identity-table")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
    });

    test("assurance: a known attack whose detector stopped firing reads MISSED, not out of scope", async ({ page }) => {
      const assurance = {
        assurance: { controls: [{ id: "verify.replay", title: "Delegation replay defense (jti)", status: "active", detail: "Accepted once." }], activeCount: 1, partialCount: 0, gapCount: 0, total: 1, score: 100 },
        adversarial: { results: [{ id: "replay", attack: "An agent replays a captured delegation.", control: "Replay defense (jti)", defended: true, detail: "" }], defendedCount: 1, total: 1, allDefended: true },
        breaches: {
          results: [
            { id: "injection", attack: "An agent sends a live SQL injection payload in a request.", realWorld: "Injection.", coverage: "missed", control: "Edge payload detector.", detail: "NOT detected by the payload engine" },
            { id: "supply-chain", attack: "Build-pipeline compromise.", realWorld: "SolarWinds class.", coverage: "out_of_scope", control: "Out of scope.", detail: "" },
          ],
          prevented: 0, detected: 0, missed: 1, outOfScope: 1, total: 2,
        },
        lowAndSlow: { profiles: [], detected: 0, total: 0, rate: 0, evasiveRate: 0, note: "" },
      };
      await stubInstinctSession(page, { role: "cto" });
      await stubBoard(page, { summary: summary(), permissions: { ...INTEL, manageOperators: true } });
      let assuranceStatus = 0;
      await page.route(/\/api\/admin\/forcefield\/assurance(\?|$)/, (route) => {
        assuranceStatus = 200;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(assurance) });
      });
      const snapshot = collectConsoleAndNetworkFailures(page);
      await openDefense(page);
      await page.getByText(/Assurance & self-test/i).click();
      await expect(page.getByTestId("assurance-breach-injection")).toContainText("MISSED");
      await expect(page.getByTestId("assurance-breach-injection")).not.toContainText(/out of scope/i);
      await expect(page.getByTestId("assurance-breach-supply-chain")).toContainText(/out of scope/i);
      await expect(page.getByTestId("breach-missed")).toHaveText("1 MISSED");
      expect(assuranceStatus, "the assurance API answered 200").toBe(200);
      expectNoFailures(snapshot);
    });
  });

  test.describe("live (real sign-in, real board API)", () => {
    test.beforeEach(async ({ page }) => {
      const signedIn = await signInIfPossible(page, target);
      if (!signedIn) {
        if (process.env.CI === "true" && target.isProduction) {
          throw new Error("CI misconfiguration: the Forcefield board live E2E needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
        }
        test.skip();
      }
    });

    test("the real board API answers 200 and the panel shows content or its empty state", async ({ page }) => {
      const snapshot = collectConsoleAndNetworkFailures(page);
      const apiResp = page.waitForResponse((r) => /\/api\/admin\/site-analytics(\?|$)/.test(r.url()));
      const nav = await page.goto(`${target.baseUrl}${PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      expect(nav?.status()).toBe(200);
      const resp = await apiResp;
      expect(resp.status(), "board API 200").toBe(200);
      const body = (await resp.json()) as { summary: Record<string, unknown>; permissions: { viewIntel: boolean } };
      expect(body.summary).toHaveProperty("forcefield");
      await expect(page.getByTestId("site-analytics-page")).toBeVisible({ timeout: 30_000 });
      if (!body.permissions.viewIntel) {
        // A non-intel viewer must not receive the deep intel at all.
        expect(body.summary).not.toHaveProperty("defense");
        await expect(page.getByTestId("tab-forcefield")).toHaveCount(0);
        expectNoFailures(snapshot);
        return;
      }
      expect(body.summary, "intel holders get the defense block").toHaveProperty("defense");
      await page.getByTestId("tab-forcefield").click();
      await expect(page.getByTestId("ff-defense")).toBeVisible();
      const empty = await page.getByTestId("ff-defense-empty").count();
      if (empty === 0) {
        await expect(page.getByTestId("ff-defense-enforcement"), "populated board shows the enforcement row").toBeVisible();
        await expect(page.getByTestId("ff-defense-identity")).toBeVisible();
      }
      expectNoFailures(snapshot);
    });
  });
});
