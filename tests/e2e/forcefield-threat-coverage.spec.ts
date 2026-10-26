/**
 * Forcefield admin page, threat-coverage panel, E2E in a real browser.
 *
 * The matrix is computed by running each row's sample through the real engine,
 * so this spec asserts what the engine earned, never a typed number: the gap
 * callout's count matches the gap rows it lists (with correct grammar), and the
 * three rows closed by engine rules (SECRET-FILES, WP-PLUGIN-ABUSE,
 * CRAWLER-IMPERSONATION) read covered and are not in the callout. Stubbed
 * session + fixed API responses (no database). Asserts HTTP 200, no CSP
 * violations or page errors, reload, and phone width.
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/forcefield-threat-coverage.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const CLOSED = ["SECRET-FILES", "WP-PLUGIN-ABUSE", "CRAWLER-IMPERSONATION"];

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

async function stubForcefieldApis(page: Page): Promise<void> {
  await page.route(/\/api\/admin\/forcefield\/canaries(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canaries: [] }) }));
  await page.route(/\/api\/admin\/forcefield\/trips(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trips: [] }) }));
  await page.route(/\/api\/admin\/forcefield\/exposure(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, kev: { catalogVersion: "2026.10.23", dateReleased: "2026-10-23T00:00:00Z" }, scope: "", findings: [] }) }));
}

async function open(page: Page): Promise<void> {
  const nav = await page.goto(`${target.baseUrl}/admin/forcefield`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), "/admin/forcefield loads 200").toBe(200);
  await expect(page.getByTestId("threat-coverage")).toBeVisible({ timeout: 30_000 });
}

async function assertPanel(page: Page): Promise<void> {
  await expect(page.getByTestId("coverage-headline")).toHaveText(/\d+ \/ \d+ agent-observable threats detected/i);
  for (const id of CLOSED) await expect(page.getByTestId(`coverage-row-${id}`).locator("td").last()).toHaveText(/^\s*covered\s*$/i);
  const callout = page.getByTestId("coverage-gaps");
  if ((await callout.count()) === 0) {
    // No gaps left: an explicit statement, never a blank where the callout was.
    await expect(page.getByTestId("coverage-no-gaps")).toContainText(/no open gaps/i);
    const statuses = await page.locator('[data-testid^="coverage-row-"] td:last-child').allTextContents();
    expect(statuses.filter((t) => t.trim().toLowerCase() === "gap")).toEqual([]);
    return;
  }
  await expect(page.getByTestId("coverage-no-gaps")).toHaveCount(0);
  const countText = (await page.getByTestId("coverage-gaps-count").innerText()).trim();
  const m = countText.match(/^(\d+) (gap|gaps) to close/i);
  expect(m, `gap count line: "${countText}"`).not.toBeNull();
  const n = Number(m![1]);
  expect(m![2].toLowerCase()).toBe(n === 1 ? "gap" : "gaps");
  // Every listed gap is a gap row in the table, and the count matches the list.
  const statuses = await page.locator('[data-testid^="coverage-row-"] td:last-child').allTextContents();
  expect(statuses.filter((t) => t.trim().toLowerCase() === "gap").length).toBe(n);
  for (const id of CLOSED) await expect(callout).not.toContainText(id);
}

test.describe("forcefield threat coverage: deterministic (stubbed session + fixed data)", () => {
  test.use({ serviceWorkers: "block" });

  test("200, the panel renders the computed coverage, closed gaps read covered, no CSP violations", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubForcefieldApis(page);
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await assertPanel(page);
    expectNoFailures(snapshot);
  });

  test("reload: renders the same computed panel again", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stubForcefieldApis(page);
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("threat-coverage")).toBeVisible({ timeout: 30_000 });
    await assertPanel(page);
    expectNoFailures(snapshot);
  });

  test("phone width: the panel renders without horizontal page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await stubInstinctSession(page, { role: "cto" });
    await stubForcefieldApis(page);
    await open(page);
    await assertPanel(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("unauthenticated: redirects to /login, never a blank panel", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/forcefield`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL(/\/login\?next=%2Fadmin%2Fforcefield|\/login\?next=\/admin\/forcefield/, { timeout: 30_000 });
  });
});
