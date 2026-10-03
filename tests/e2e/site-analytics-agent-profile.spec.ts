/**
 * Forcefield Web - LIVE client journeys (/admin/site-analytics).
 *
 * The last place to catch a client-facing break before a client sees it. Unit +
 * component tests prove the profile builder and the shaping; these drive the
 * DEPLOYED app in a real browser through the journeys a client actually runs:
 * open the board, read site usage, switch to agent defense, see operators OR an
 * honest empty state, open the severity triage view, and filter by property -
 * asserting HTTP 200 (never a blank 401), no CSP/console/network failures, and
 * that every surface renders real content or an explicit empty state.
 *
 * Previously this asserted ff-journeys-triage was visible on load - but that
 * widget lives in the Agent-defense tab (hidden until clicked) AND the severity
 * view (display:none until selected), so it never rendered on load and the spec
 * could not have passed against populated prod. Fixed: each journey navigates to
 * the right tab/view first.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL; skips when
 * unavailable (like every smoke spec here). Data-tolerant: no journeys yet ->
 * asserts the honest empty state rather than failing.
 */

import { test, expect, type Page } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible, collectConsoleAndNetworkFailures } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/** Open the board (signed in) and assert it loads 200 + the page shell mounts.
 *  Returns the console/network-failure snapshot for an end-of-journey assertion. */
async function openBoard(page: Page): Promise<() => { kind: string; detail: string }[]> {
  const snapshot = collectConsoleAndNetworkFailures(page);
  const nav = await page.goto(`${target.baseUrl}/admin/site-analytics`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  // 200, not merely "not 500": a 401 renders blank, the exact client bad-first-impression.
  expect(nav?.status(), "/admin/site-analytics loads (not 401/blank)").toBe(200);
  await expect(page.getByTestId("site-analytics-page"), "the board shell mounts").toBeVisible({ timeout: 15_000 });
  return snapshot;
}

test.describe("Forcefield Web - LIVE client journeys", () => {
  test("1) an unauthenticated visit redirects to /login (never a blank admin page)", async ({ browser }) => {
    // Fresh context, no sign-in. This journey needs no creds, so it never skips.
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${target.baseUrl}/admin/site-analytics`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/login");
    } finally {
      await ctx.close();
    }
  });

  test.describe("signed in", () => {
    test.beforeEach(async ({ page }) => {
      const signedIn = await signInIfPossible(page, target);
      if (!signedIn) {
        // In CI the dogfood workflow supplies the smoke creds, so a failed sign-in
        // there is a misconfiguration that must FAIL LOUDLY - never skip green and
        // hide that the live board was never exercised. Locally it skips cleanly.
        if (process.env.CI === "true") {
          throw new Error("CI misconfiguration: the Forcefield Web dogfood needs a working SMOKE_TEST_EMAIL/PASSWORD login against PROD_URL.");
        }
        test.skip();
      }
    });

    test("2) the usage board loads with an honest scope + a per-property filter, no console/network failures", async ({ page }) => {
      const snapshot = await openBoard(page);
      await expect(page.getByTestId("tab-panel-usage"), "the default usage panel renders").toBeVisible();
      await expect(page.getByTestId("surface-filter"), "the per-property filter renders").toBeVisible();
      const failures = snapshot();
      expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
    });

    test("3) Agent defense shows operators OR an honest empty state, and always the false-positive rate", async ({ page }) => {
      await openBoard(page);
      await page.getByTestId("tab-forcefield").click();
      await expect(page.getByTestId("tab-panel-forcefield"), "the agent-defense panel opens").toBeVisible();
      await expect(page.getByTestId("ff-journeys"), "the journeys card renders").toBeVisible({ timeout: 10_000 });
      // The honest FP-rate is the surface's distinguishing virtue, but it renders
      // only once an analyst has marked a verdict not-hostile (falsePositives > 0) -
      // correctly absent on a board with no corrections yet. When present it must
      // carry the honest "marked not hostile" framing.
      const fpRate = page.getByTestId("ff-fp-rate");
      if ((await fpRate.count()) > 0) {
        await expect(fpRate).toContainText(/not hostile|false-positive/i);
      }
      // Operator view is the default; either operator rows render, or the honest empty state.
      const ops = page.getByTestId("ff-operators-view");
      await expect(ops, "the operator view renders").toBeVisible();
      const hasOperators = (await page.locator('[data-testid^="operator-"]').count()) > 0;
      if (!hasOperators) {
        await expect(ops, "an empty board shows the honest empty state, not a blank").toContainText(/no correlated agent journeys yet/i);
      }
    });

    test("4) the severity view reveals the triage board (the widget that is hidden on load)", async ({ page }) => {
      await openBoard(page);
      await page.getByTestId("tab-forcefield").click();
      await page.getByTestId("journey-view-severity").click();
      await expect(page.getByTestId("ff-journeys-triage"), "the triage board renders in severity view").toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("triage-summary"), "the triage summary renders").toBeVisible();
    });

    test("5) opening an operator profile reveals the honest dossier (identity disclaimer intact)", async ({ page }) => {
      await openBoard(page);
      await page.getByTestId("tab-forcefield").click();
      // The profile opens via a per-journey "View details" toggle, which is nested
      // inside an operator group - expand the group's findings first if needed.
      const toggle = page.locator('[data-testid^="ff-journey-profile-toggle-"]').first();
      if (!(await toggle.isVisible().catch(() => false))) {
        const showFindings = page.getByRole("button", { name: /show \d+ finding/i }).first();
        if (await showFindings.isVisible().catch(() => false)) await showFindings.click().catch(() => {});
      }
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
        // The expanded dossier carries the verdict rationale + the identity
        // disclaimer. Assert on its unique copy (the panel testid also prefixes the
        // toggle, so match by text instead).
        await expect(page.getByText(/why this verdict/i).first(), "the dossier opens").toBeVisible({ timeout: 10_000 });
        await expect(
          page.getByText(/does not establish a real-world identity/i).first(),
          "the identity disclaimer is never dropped",
        ).toBeVisible();
      } else {
        // No openable profile (quiet board, or all collapsed) - confirm the operator
        // surface still renders rather than a blank.
        await expect(page.getByTestId("ff-operators-view")).toBeVisible();
      }
    });

    test("6) switching the per-property filter reloads the board without error", async ({ page }) => {
      const snapshot = await openBoard(page);
      const buttons = page.getByTestId("surface-filter").getByRole("button");
      if ((await buttons.count()) > 1) {
        await buttons.nth(1).click();
        await expect(page.getByTestId("site-analytics-page"), "the board stays mounted after a filter switch").toBeVisible();
      }
      const failures = snapshot();
      expect(failures, `failures:\n${failures.map((f) => `  - [${f.kind}] ${f.detail}`).join("\n")}`).toEqual([]);
    });
  });
});
