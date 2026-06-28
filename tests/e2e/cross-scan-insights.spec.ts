/**
 * Cross-scan intelligence console reality check (/admin/cross-scan-insights).
 *
 * The cross-scan insights console is the operator/client-facing surface for the
 * moat: higher-order insights correlated across modalities (frontend / backend /
 * db / security / ux / perf) AND across time (resolved->reopened) - compound
 * risks, regressions, systemic patterns, coverage blind spots. This spec proves,
 * at the layer the jest suite cannot reach, that the page is wired to a real API
 * against a real DB and renders cleanly in the browser.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a dashboard that
 * blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths:
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER
 *      the metric tiles + insight feed render OR the explicit empty state renders,
 *      with ZERO CSP/network failures over a 3s idle window.
 *
 * Best-effort and non-destructive: it never triggers a generation (no POST), so
 * prod insight data is not polluted; it only asserts the page renders.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Cross-scan intelligence console reality check", () => {
  test("unauthenticated visit to /admin/cross-scan-insights redirects to /login (never blank)", async ({
    page,
  }) => {
    await page.goto(`${target.baseUrl}/admin/cross-scan-insights`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated /admin/cross-scan-insights lands on /login, not a blank dashboard",
    ).toBe(true);
  });

  test("authenticated /admin/cross-scan-insights renders the feed OR the empty state cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds - authenticated cross-scan path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/cross-scan-insights`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/cross-scan-insights loads (not 401/blank)").toBe(200);

    // The page is not blank: the title is rendered.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    expect(bodyText.includes("cross-scan"), "the cross-scan page is not blank").toBe(true);

    // The page-level container is always present.
    await expect(
      page.getByTestId("cross-scan-insights-page"),
      "the cross-scan insights page container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // Either the metric tiles (with data) OR the explicit empty state is in the
    // DOM, never a silent blank.
    const metrics = page.getByTestId("insights-metrics");
    const empty = page.getByTestId("insights-empty");
    const metricsCount = await metrics.count();
    const emptyCount = await empty.count();
    expect(
      metricsCount + emptyCount,
      "the metric tiles or the explicit empty-state testid is rendered",
    ).toBeGreaterThan(0);

    if (metricsCount > 0) {
      await expect(page.getByTestId("metric-total"), "the total metric tile renders").toBeVisible();
      await expect(page.getByTestId("insights-feed"), "the insight feed renders").toBeVisible();
    } else {
      await expect(empty, "the empty state explains the next step").toContainText(
        /no cross-scan insights yet/i,
      );
    }

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/cross-scan-insights:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
