/**
 * Evidence-backed status surfaces, E2E in a real browser.
 *
 * Every status a client sees must come from evidence that the control ran. This
 * spec drives the four surfaces that show one:
 *   - the Forcefield assurance panel (/admin/site-analytics -> Agent defense)
 *   - the gate regression set page (/admin/ai-redteam)
 *   - the public security posture page (/security-posture)
 *   - the Trust Center (/admin/trust-center)
 *
 *  A. DETERMINISTIC (always runs, no database): a stubbed session plus fixed API
 *     responses for every state: fresh evidence (active), stale evidence (gap),
 *     a query error (unknown), an API error, an empty history, reload, and a
 *     phone-width viewport. Asserts HTTP 200 for the page and its API, no CSP
 *     violations or page errors, and that each widget renders content or its
 *     explicit empty / error state.
 *
 *  B. LIVE (runs when SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are set): real
 *     sign-in against the deployment; the real assurance API answers 200 and no
 *     control reads "active" without fresh evidence; the real parity API answers
 *     200 with no page/registry drift and no violation. Fails loudly in CI when
 *     the creds are configured but sign-in does not work.
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/evidence-backed-status.spec.ts --grep-invert "real sign-in"
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, stubInstinctSession, collectConsoleAndNetworkFailures, authToken } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type State = "fresh" | "stale" | "none" | "error";
const ev = (key: string, state: State, windowDays = 7) => ({
  key,
  proof: `${key} proof`,
  windowDays,
  count: state === "fresh" ? 5 : 0,
  lastAt: state === "fresh" ? "2026-10-23T09:00:00.000Z" : state === "stale" ? "2026-08-01T00:00:00.000Z" : null,
  state,
  ...(state === "error" ? { error: "relation does not exist" } : {}),
});

function assuranceBody(state: State) {
  const status = state === "fresh" ? "active" : state === "error" ? "unknown" : "gap";
  const controls = [
    { id: "enforce.inline", title: "Inline edge enforcement", status, detail: `inline ${status}`, evidence: [ev("ff.inline_block", state)] },
    { id: "detect.decoys", title: "Web decoy traps", status, detail: `decoys ${status}`, evidence: [ev("ff.trap_tripped", state, 30)] },
    { id: "audit.hash_chain", title: "Tamper-evident audit (hash chain)", status, detail: `chain ${status}`, evidence: [ev("audit.chain_verified", state, 1)] },
    { id: "crypto.pq_signatures", title: "Post-quantum signatures (ML-DSA)", status: "gap", detail: "Not running.", evidence: [], enablement: "Implement the ML-DSA-65 slot." },
  ];
  const count = (s: string) => controls.filter((c) => c.status === s).length;
  return {
    assurance: {
      controls,
      activeCount: count("active"),
      partialCount: 0,
      gapCount: count("gap"),
      unknownCount: count("unknown"),
      total: controls.length,
      score: Math.round((count("active") / controls.length) * 100),
      measuredAt: "2026-10-24T12:00:00.000Z",
    },
    adversarial: { results: [{ id: "replay", attack: "An agent replays a captured delegation.", control: "Replay defense (jti)", defended: true, detail: "" }], defendedCount: 1, total: 1, allDefended: true },
    breaches: { results: [], prevented: 0, detected: 0, missed: 0, outOfScope: 0, total: 0 },
    lowAndSlow: { profiles: [], detected: 0, total: 0, rate: 0, evasiveRate: 0, note: "" },
  };
}

const BOARD = {
  summary: {
    rangeDays: 30, surfaces: ["instinct"], surface: "all", totalPageViews: 10, collectsPageViews: true, totalEvents: 40,
    byHour: [], byPage: [], byCountry: [], byType: [],
    forcefield: { welcomed: 0, flagged: 0, trapped: 0, blocked: 0, wouldBlock: 0, hostileOperators: 0, hostileEvents: 0, topAgents: [] },
    learnedSignatures: { shadow: 0, enforcing: 0, autoBlocked: 0 },
    agentIntel: { operators: 0, campaigns: 0, automationFleet: 0, aiAgents: 0, scripts: 0, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] },
    journeys: [], agentOrigins: [], probeIntel: [], payloadIntel: [], operatorTriage: {}, blockedOperators: [], networkReputation: {}, networkTradecraft: [], principalByOperator: {},
    verdictFeedback: { falsePositives: 0 },
    defense: {
      enforcement: { blocked: 0, wouldBlock: 0, byReason: [] },
      highRate: { bursts: 0, operators: 0, peakRate: 0, windowSeconds: null, fromIngest: 0 },
      identity: { verified: 0, impersonation: 0, unverifiable: 0, signed: 0, byAgent: [] },
      probes: [], networks: [],
    },
  },
  permissions: { triage: false, manageOperators: true, viewIntel: true },
};

async function stubBoardAndAssurance(page: Page, assurance: unknown, status = 200): Promise<{ hits: () => number }> {
  let hits = 0;
  await page.route(/\/api\/admin\/site-analytics(\?|$)/, (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BOARD) }));
  await page.route(/\/api\/admin\/forcefield\/(edge-policy|reputation-optin)/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(/\/api\/admin\/forcefield\/assurance(\?|$)/, (route) => {
    hits++;
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(assurance) });
  });
  return { hits: () => hits };
}

async function openAssurance(page: Page): Promise<number> {
  const nav = await page.goto(`${target.baseUrl}/admin/site-analytics`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), "/admin/site-analytics loads 200").toBe(200);
  await expect(page.getByTestId("site-analytics-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("tab-forcefield").click();
  const apiResp = page.waitForResponse((r) => /\/api\/admin\/forcefield\/assurance(\?|$)/.test(r.url()));
  await page.getByText(/Assurance & self-test/i).click();
  return (await apiResp).status();
}

const SUITE = {
  kind: "fixed_regression",
  cases: 8,
  label: "Fixed gate regression set (8 cases)",
  description: "8 fixed, hand-written agent actions sent through the real OGIAM policy decide() path on a schedule.",
  limits: "It never calls a model and never generates new attacks, so a pass means the policy still blocks these known cases. It is not red-team coverage.",
};
const RUN = { id: "art_1", attacksRun: 8, blocked: 8, vulns: 0, passRate: 1, risk: "low", source: "cron", createdAt: "2026-10-20T06:00:00.000Z" };

async function stubRedteam(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route(/\/api\/admin\/ai-redteam\/run(\?|$)/, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
}

// ---------------------------------------------------------------------------
// A. Deterministic
// ---------------------------------------------------------------------------

test.describe("evidence-backed status: deterministic (stubbed session + fixed data)", () => {
  // Block the service worker so every request hits the page.route fixtures.
  test.use({ serviceWorkers: "block" });

  test("assurance, fresh evidence: controls read active and show the evidence they rest on", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoardAndAssurance(page, assuranceBody("fresh"));
    const snapshot = collectConsoleAndNetworkFailures(page);
    expect(await openAssurance(page), "assurance API 200").toBe(200);
    await expect(page.getByTestId("assurance-control-enforce.inline")).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("assurance-status-enforce.inline")).toHaveText(/active/i);
    await expect(page.getByTestId("assurance-evidence-enforce.inline-ff.inline_block")).toContainText("5 in 7d, last 2026-10-23");
    await expect(page.getByTestId("assurance-evidence-enforce.inline-ff.inline_block")).toHaveAttribute("data-state", "fresh");
    await expect(page.getByTestId("assurance-measured-at")).toContainText("2026-10-24 12:00 UTC");
    // a control with no evidence is a gap, with a step to close it
    await expect(page.getByTestId("assurance-control-crypto.pq_signatures")).toHaveAttribute("data-status", "gap");
    await expect(page.getByTestId("assurance-enable-crypto.pq_signatures")).toContainText("To enable");
    await expect(page.getByTestId("assurance-unknown-count")).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("assurance, stale evidence: every evidence-backed control reads gap, never active", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoardAndAssurance(page, assuranceBody("stale"));
    const snapshot = collectConsoleAndNetworkFailures(page);
    expect(await openAssurance(page)).toBe(200);
    for (const id of ["enforce.inline", "detect.decoys", "audit.hash_chain"]) {
      await expect(page.getByTestId(`assurance-control-${id}`)).toHaveAttribute("data-status", "gap");
    }
    await expect(page.getByTestId("assurance-evidence-audit.hash_chain-audit.chain_verified")).toContainText("none in 1d, last 2026-08-01");
    await expect(page.getByTestId("assurance-score")).toHaveText("0%");
    await expect(page.locator('[data-status="active"]')).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("assurance, query error: controls read unknown with the reason, never active", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoardAndAssurance(page, assuranceBody("error"));
    const snapshot = collectConsoleAndNetworkFailures(page);
    expect(await openAssurance(page)).toBe(200);
    await expect(page.getByTestId("assurance-control-enforce.inline")).toHaveAttribute("data-status", "unknown");
    await expect(page.getByTestId("assurance-unknown-count")).toHaveText("3 unknown");
    await expect(page.getByTestId("assurance-evidence-enforce.inline-ff.inline_block")).toContainText("could not be measured: relation does not exist");
    await expect(page.locator('[data-status="active"]')).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("assurance, API error: an explicit error line, never a blank or a fake posture", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubBoardAndAssurance(page, { error: "boom" }, 500);
    expect(await openAssurance(page)).toBe(500);
    await expect(page.getByTestId("assurance-error")).toBeVisible();
    await expect(page.getByTestId("assurance-score")).toHaveCount(0);
  });

  test("assurance, phone width: renders without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await stubInstinctSession(page, { role: "cto" });
    await stubBoardAndAssurance(page, assuranceBody("fresh"));
    expect(await openAssurance(page)).toBe(200);
    await expect(page.getByTestId("assurance-evidence-detect.decoys-ff.trap_tripped")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page overflow at 390px").toBeLessThanOrEqual(1);
  });

  test("gate regression set: says what it is, with N cases and the last run date", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubRedteam(page, { runs: [RUN], suite: SUITE });
    const snapshot = collectConsoleAndNetworkFailures(page);
    const apiResp = page.waitForResponse((r) => /\/api\/admin\/ai-redteam\/run(\?|$)/.test(r.url()));
    const nav = await page.goto(`${target.baseUrl}/admin/ai-redteam`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(nav?.status()).toBe(200);
    expect((await apiResp).status()).toBe(200);
    const scope = page.getByTestId("ai-redteam-scope");
    await expect(scope).toBeVisible({ timeout: 30_000 });
    await expect(scope).toHaveAttribute("data-kind", "fixed_regression");
    await expect(scope).toContainText("Fixed gate regression set (8 cases)");
    await expect(scope).toContainText("not red-team coverage");
    await expect(page.getByTestId("ai-redteam-last-run")).toHaveText("Last run: 2026-10-20.");
    await expect(page.getByText("Pass rate (fixed set, 8 cases)")).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI Red-Team" })).toHaveCount(0);
    await expect(page.getByTestId("ai-redteam-row")).toHaveCount(1);
    expectNoFailures(snapshot);
  });

  test("gate regression set, no runs: the empty state and 'Never run', not a pass", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubRedteam(page, { runs: [], suite: SUITE });
    await page.goto(`${target.baseUrl}/admin/ai-redteam`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(page.getByTestId("ai-redteam-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ai-redteam-last-run")).toHaveText("Never run.");
  });

  test("gate regression set, API error: an explicit error, never a blank page", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubRedteam(page, { error: "boom" }, 500);
    await page.goto(`${target.baseUrl}/admin/ai-redteam`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(page.getByTestId("ai-redteam-error")).toBeVisible({ timeout: 30_000 });
  });

  test("gate regression set, reload: refetches and renders again", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    let hits = 0;
    await page.route(/\/api\/admin\/ai-redteam\/run(\?|$)/, (route) => {
      hits++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [RUN], suite: SUITE }) });
    });
    await page.goto(`${target.baseUrl}/admin/ai-redteam`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(page.getByTestId("ai-redteam-scope")).toBeVisible({ timeout: 30_000 });
    const before = hits;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ai-redteam-last-run")).toHaveText("Last run: 2026-10-20.", { timeout: 30_000 });
    expect(hits).toBeGreaterThan(before);
  });

  test("trust center: states only what is true today", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/trust-center`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(nav?.status()).toBe(200);
    const posture = page.getByTestId("trust-security-posture");
    await expect(posture).toBeVisible({ timeout: 30_000 });
    await expect(posture).toContainText("CodeQL runs on every pull request but is not yet a required check");
    await expect(posture).toContainText("row-level security does not enforce it yet");
    await expect(page.getByTestId("trust-self-testing")).toContainText("not red-team coverage");
    await expect(page.getByTestId("trust-center")).not.toContainText(/browser platform scan/i);
    expectNoFailures(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Public page: no session needed, real document
// ---------------------------------------------------------------------------

test.describe("public security posture page", () => {
  test("200, the Control status table renders, the false claims are gone, no CSP violations", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/security-posture`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(nav?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Control status" })).toBeVisible({ timeout: 30_000 });
    const body = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    for (const key of ["isolation.db_rls", "auth.mfa_enforced", "secrets.oauth_tokens_encrypted", "ci.codeql_required", "audit.hash_chain"]) {
      expect(body, `evidence key ${key} is on the page`).toContain(key);
    }
    expect(body).toMatch(/Multi-factor authentication enforced for administrators Not in place/);
    expect(body).toMatch(/Microsoft Graph and QuickBooks OAuth tokens encrypted by the application In progress/);
    expect(body).not.toMatch(/OAuth refresh tokens, multi-factor seeds and compliance evidence, are encrypted/);
    expectNoFailures(snapshot);
  });

  test("phone width: no horizontal page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${target.baseUrl}/security-posture`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Control status" })).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// B. Live
// ---------------------------------------------------------------------------

test.describe("evidence-backed status: live (real sign-in, real APIs)", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      if (process.env.CI === "true" && target.isProduction) {
        throw new Error("CI misconfiguration: the evidence-backed status live E2E needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
      }
      test.skip();
    }
  });

  test("the real assurance API answers 200 and nothing reads active without fresh evidence", async ({ page }) => {
    const token = await authToken(page);
    const res = await page.request.get(`${target.baseUrl}/api/admin/forcefield/assurance`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { assurance: { controls: Array<{ id: string; status: string; evidence: Array<{ state: string }> }> } };
    expect(body.assurance.controls.length).toBeGreaterThan(5);
    for (const c of body.assurance.controls) {
      expect(["active", "partial", "gap", "unknown"]).toContain(c.status);
      if (c.status === "active") {
        expect(c.evidence.length, `${c.id} is active with no evidence`).toBeGreaterThan(0);
        expect(c.evidence.every((e) => e.state === "fresh"), `${c.id} is active on non-fresh evidence`).toBe(true);
      }
    }
  });

  test("the real parity API: the public page matches its evidence checks", async ({ page }) => {
    const token = await authToken(page);
    const res = await page.request.get(`${target.baseUrl}/api/admin/security-posture/parity`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { violations: number; docDrift: string[]; results: Array<{ key: string; violation: boolean }> };
    expect(body.docDrift).toEqual([]);
    expect(body.results.filter((r) => r.violation).map((r) => r.key)).toEqual([]);
  });

  test("the real gate regression page labels itself honestly", async ({ page }) => {
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ai-redteam`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    expect(nav?.status()).toBe(200);
    await expect(page.getByTestId("ai-redteam-scope")).toContainText("not red-team coverage", { timeout: 30_000 });
    await expect(page.getByTestId("ai-redteam-last-run")).toHaveText(/Last run: \d{4}-\d{2}-\d{2}\.|Never run\./);
    expectNoFailures(snapshot);
  });
});
