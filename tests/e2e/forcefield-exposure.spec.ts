/**
 * Forcefield admin page, Exposure panel, E2E in a real browser.
 *
 * Stubbed session + fixed API responses (no database, synthetic data only).
 * Covers: findings render with CVEs, explicit empty state, explicit
 * switched-off state, explicit error state, reload, phone width, and an
 * unauthenticated redirect. Every authenticated case asserts HTTP 200 and no
 * console / CSP / page errors.
 *
 * Run locally against a production build (dev-mode CSP blocks hydration):
 *   INSTINCT_JWT_SECRET=<any 32+ chars> npx next build && npx next start -p 3217 &
 *   PROD_URL=http://localhost:3217 npx playwright test tests/e2e/forcefield-exposure.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const KEV = { catalogVersion: "2026.10.23", dateReleased: "2026-10-23T19:30:18.9209Z" };
const SCOPE = "Outside-in exposure monitoring of verified targets. Forcefield does not sit in front of these appliances and does not protect them.";
const FINDING = {
  id: "f1", platform: "example-target", route: "/", severity: "critical",
  title: "Internet-facing Ivanti Connect Secure / Pulse Secure VPN portal with known-exploited CVEs",
  status: "open", vendor: "Ivanti", product: "ivanti_connect_secure",
  cveIds: ["CVE-2025-0282", "CVE-2024-21887", "CVE-2023-46805"], knownRansomware: true, createdAt: "2026-10-26T00:00:00.000Z",
};

function expectNoFailures(snapshot: () => { kind: string; detail: string }[]): void {
  const failures = snapshot();
  expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
}

async function stub(page: Page, exposure: { status: number; body: unknown }): Promise<void> {
  await page.route(/\/api\/admin\/forcefield\/canaries(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canaries: [] }) }));
  await page.route(/\/api\/admin\/forcefield\/trips(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trips: [] }) }));
  await page.route(/\/api\/admin\/forcefield\/exposure(\?|$)/, (r) => r.fulfill({ status: exposure.status, contentType: "application/json", body: JSON.stringify(exposure.body) }));
}

async function open(page: Page): Promise<void> {
  const nav = await page.goto(`${target.baseUrl}/admin/forcefield`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  expect(nav?.status(), "/admin/forcefield loads 200").toBe(200);
  await expect(page.getByTestId("exposure-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("exposure-scope")).toContainText(/does not protect them/);
}

test.describe("forcefield exposure panel (stubbed session + fixed data)", () => {
  test.use({ serviceWorkers: "block" });

  test("renders findings with their KEV CVEs, 200, no console or CSP errors", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { enabled: true, kev: KEV, scope: SCOPE, findings: [FINDING] } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await expect(page.getByTestId("exposure-row")).toHaveCount(1);
    await expect(page.getByTestId("exposure-cves")).toHaveText("CVE-2025-0282, CVE-2024-21887, CVE-2023-46805");
    await expect(page.getByTestId("exposure-kev-version")).toContainText("2026.10.23");
    expectNoFailures(snapshot);
  });

  test("explicit empty state when enabled with no findings", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { enabled: true, kev: KEV, scope: SCOPE, findings: [] } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await expect(page.getByTestId("exposure-empty")).toContainText(/No exposed edge devices/);
    await expect(page.getByTestId("exposure-row")).toHaveCount(0);
    expectNoFailures(snapshot);
  });

  test("explicit switched-off state when the check is disabled", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { enabled: false, kev: KEV, scope: SCOPE, findings: [] } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await expect(page.getByTestId("exposure-disabled")).toContainText(/switched off/);
    expectNoFailures(snapshot);
  });

  test("explicit error state when the API fails, the rest of the page still renders", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 500, body: { error: "x" } });
    await open(page);
    await expect(page.getByTestId("exposure-error")).toBeVisible();
    await expect(page.getByTestId("threat-coverage")).toBeVisible();
  });

  test("reload renders the same panel", async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { enabled: true, kev: KEV, scope: SCOPE, findings: [FINDING] } });
    const snapshot = collectConsoleAndNetworkFailures(page);
    await open(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("exposure-row")).toHaveCount(1, { timeout: 30_000 });
    expectNoFailures(snapshot);
  });

  test("phone width: no horizontal page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await stubInstinctSession(page, { role: "cto" });
    await stub(page, { status: 200, body: { enabled: true, kev: KEV, scope: SCOPE, findings: [FINDING] } });
    await open(page);
    await expect(page.getByTestId("exposure-row")).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("unauthenticated: redirects to /login, never a blank panel", async ({ page }) => {
    await page.goto(`${target.baseUrl}/admin/forcefield`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL(/\/login\?next=%2Fadmin%2Fforcefield|\/login\?next=\/admin\/forcefield/, { timeout: 30_000 });
  });
});
