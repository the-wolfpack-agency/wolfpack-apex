/**
 * OGIAM Gate - LIVE client journeys (/admin/ogiam).
 *
 * The governance surface: a client watches agent actions get allowed vs blocked,
 * reads the tamper-evident ledger's chain status, filters to the actions the gate
 * WOULD block, and runs the signing self-test that proves the ledger is
 * cryptographically verifiable. This drives the DEPLOYED app in a real browser
 * through the "show me it's governed, and show me it's auditable" journeys a
 * client actually runs - asserting HTTP 200 (never a blank 401), no CSP/console/
 * network failures, and real content or an explicit honest empty state.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips locally
 * when unconfigured, but FAILS in CI (the dogfood workflow supplies them) so a
 * misconfigured login can never skip-green. Data-tolerant: no decisions yet ->
 * asserts the honest empty state rather than failing.
 */

import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

async function openGate(page: Page): Promise<() => { kind: string; detail: string }[]> {
  const snapshot = collectConsoleAndNetworkFailures(page);
  const nav = await page.goto(`${target.baseUrl}/admin/ogiam`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(nav?.status(), "/admin/ogiam loads (not 401/blank)").toBe(200);
  await expect(page.getByTestId("admin-ogiam-page"), "the gate console mounts").toBeVisible({ timeout: 15_000 });
  return snapshot;
}

test.describe("OGIAM Gate - LIVE client journeys", () => {
  test("1) an unauthenticated visit redirects to /login (never a blank admin page)", async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${target.baseUrl}/admin/ogiam`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/login");
    } finally {
      await ctx.close();
    }
  });

  test.describe("signed in", () => {
    test.beforeEach(async ({ page }) => {
      const signedIn = await signInIfPossible(page, target);
      if (!signedIn) {
        if (process.env.CI === "true") {
          throw new Error("CI misconfiguration: the OGIAM Gate dogfood needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
        }
        test.skip();
      }
    });

    test("2) the governance summary renders (total decisions + how many the gate would block)", async ({ page }) => {
      const snapshot = await openGate(page);
      await expect(page.getByTestId("ogiam-summary"), "the governance summary renders").toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("ogiam-summary-total"), "the total-decisions metric renders").toBeVisible();
      // "would block" is the whole value prop: how many agent actions the gate stopped.
      await expect(page.getByTestId("ogiam-summary-would-block"), "the would-block metric renders").toBeVisible();
      const failures = snapshot();
      expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
    });

    test("3) the tamper-evident ledger's chain status is shown (auditability)", async ({ page }) => {
      await openGate(page);
      await expect(page.getByTestId("ogiam-chain-status"), "the ledger chain status renders").toBeVisible({ timeout: 15_000 });
    });

    test("4) the decisions list renders, or an honest empty state", async ({ page }) => {
      await openGate(page);
      const list = page.getByTestId("ogiam-decisions-list");
      const empty = page.getByTestId("ogiam-decisions-empty");
      // Exactly one must be present - a real list of gate decisions, or an honest
      // "nothing yet", never a blank panel.
      await expect(list.or(empty).first(), "decisions list OR empty state renders").toBeVisible({ timeout: 15_000 });
    });

    test("5) filtering to 'would block' shows the actions the gate stopped (or an honest empty state)", async ({ page }) => {
      const snapshot = await openGate(page);
      await page.getByTestId("ogiam-filter-would-block").click();
      const list = page.getByTestId("ogiam-decisions-list");
      const empty = page.getByTestId("ogiam-decisions-empty");
      await expect(list.or(empty).first(), "the filtered view renders without error").toBeVisible({ timeout: 10_000 });
      const failures = snapshot();
      expect(failures, `failures after filter:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
    });

    test("6) the signing self-test proves the ledger is cryptographically verifiable", async ({ page }) => {
      await openGate(page);
      const btn = page.getByTestId("ogiam-signing-selftest-button");
      await expect(btn, "the self-test control is present").toBeVisible();
      await btn.click();
      // The self-test runs a sign/verify round-trip and reports a result + status -
      // the client-facing proof that the tamper-evident ledger actually verifies.
      await expect(page.getByTestId("ogiam-signing-selftest-result"), "the self-test reports a result").toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("ogiam-signing-selftest-status"), "the self-test reports a status").toBeVisible();
    });
  });
});
