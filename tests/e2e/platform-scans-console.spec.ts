/**
 * Scan command center reality check (/admin/platform-scans).
 *
 * The platform-scans page is the flagship client-facing "view the results"
 * surface for the platform-scan agent: a dark-glass command center with a hero
 * metrics row, a severity-distribution panel, and the open-findings result grid.
 * This spec proves, at the layer the jest suite cannot reach, that the page is
 * wired to a real API against a real DB and renders cleanly in the browser.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a dashboard that
 * blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths:
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and the hero
 *      metrics + EITHER findings rows OR the explicit empty state render, with
 *      ZERO CSP/network failures over a 3s idle window.
 *
 * Auth-helper limitation: this repo's e2e session helper (signInIfPossible) is
 * credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against
 * PROD_URL. When those are absent, the authenticated path skips cleanly (does not
 * fail CI); the unauth-redirect path always runs.
 *
 * Best-effort and non-destructive: it never triggers a scan (no POST), so prod
 * scan data is not polluted; it only asserts the page renders.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Scan command center reality check", () => {
  test("unauthenticated visit to /admin/platform-scans redirects to /login (never blank)", async ({
    page,
  }) => {
    // No session seeded: the page's auth-redirect guard must send the visitor to
    // /login with a ?next back to the command center, not render an empty surface.
    await page.goto(`${target.baseUrl}/admin/platform-scans`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated /admin/platform-scans lands on /login, not a blank command center",
    ).toBe(true);
  });

  test("authenticated /admin/platform-scans renders the hero metrics + findings OR the empty state cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds — authenticated command-center path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/platform-scans`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/platform-scans loads (not 401/blank)").toBe(200);

    // The page is not blank: the command-center title is rendered.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    expect(bodyText.includes("platform scans"), "the command center is not blank").toBe(true);

    // The page-level container mounts (never the auth-pending placeholder for a
    // signed-in user).
    await expect(
      page.getByTestId("platform-scans-page"),
      "the command-center container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // The hero metrics row renders with its tiles (open findings + critical are
    // always present regardless of whether any scan has run).
    await expect(
      page.getByTestId("hero-metrics"),
      "the hero metrics row renders",
    ).toBeVisible();
    await expect(
      page.getByTestId("metric-open"),
      "the open-findings hero tile renders",
    ).toBeVisible();
    await expect(
      page.getByTestId("metric-critical"),
      "the critical hero tile renders",
    ).toBeVisible();

    // The severity-distribution panel renders (with segments when there are
    // findings, or the explicit empty band when there are none).
    await expect(
      page.getByTestId("severity-distribution"),
      "the severity-distribution bar renders",
    ).toBeVisible();

    // The findings panel resolves to EITHER a list of rows OR the explicit empty
    // state — never a silent blank.
    const list = page.getByTestId("findings-list");
    const empty = page.getByTestId("findings-empty");
    const listCount = await list.count();
    const emptyCount = await empty.count();
    expect(
      listCount + emptyCount,
      "the findings list or the explicit empty-state testid is rendered",
    ).toBeGreaterThan(0);
    if (emptyCount > 0) {
      await expect(empty, "the empty state explains the next step").toContainText(
        /no open findings/i,
      );
    }

    // The run-scan control deck is present (the operator can drive a scan).
    await expect(
      page.getByTestId("run-scan"),
      "the run-scan control renders",
    ).toBeVisible();

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/platform-scans:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);

    // --- Mobile pass (390x844): the layout-bug fixes must hold on a phone. ---
    // The run-scan deck + findings controls historically overflowed and were cut
    // off on the right; this asserts NO horizontal overflow and that the key
    // controls sit within the viewport. Same authed page, smaller viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${target.baseUrl}/admin/platform-scans`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await expect(
      page.getByTestId("platform-scans-page"),
      "the command center mounts on mobile",
    ).toBeVisible({ timeout: 8_000 });

    // No horizontal overflow: the document is not wider than the viewport
    // (a small 2px slack absorbs sub-pixel rounding / scrollbar gutter).
    const noOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth + 2,
    );
    expect(noOverflow, "no horizontal overflow on a 390px viewport").toBe(true);

    // The run-scan control + the findings controls render within the viewport
    // (right edge not clipped off-screen).
    for (const testId of ["run-scan", "platform-select", "mode-select", "severity-filter"]) {
      const el = page.getByTestId(testId);
      if ((await el.count()) === 0) continue;
      await expect(el, `${testId} is visible on mobile`).toBeVisible();
      const box = await el.boundingBox();
      expect(box, `${testId} has a layout box on mobile`).not.toBeNull();
      if (box) {
        expect(
          box.x + box.width,
          `${testId} right edge stays within the 390px viewport`,
        ).toBeLessThanOrEqual(390 + 2);
      }
    }

    // The client-facing coverage map renders on mobile too (stacked rows).
    await expect(
      page.getByTestId("validation-coverage"),
      "the validation-coverage map renders on mobile",
    ).toBeVisible();
  });
});
