/**
 * Benchmark dashboard reality check (/admin/benchmark).
 *
 * The benchmark dashboard is the operator-facing surface that turns the
 * active-learning loop into actionable work: recall/precision/coverage trend over
 * time plus the live learning-signal backlog (coverage_gap -> build a detector;
 * noise_candidate -> precision-tune). This spec proves, at the layer the jest
 * suite cannot reach, that the page is wired to a real API against a real DB and
 * renders cleanly in the browser.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a dashboard that
 * blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths:
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER
 *      the summary cards + backlog render with non-zero content OR the explicit
 *      empty state renders, with ZERO CSP/network failures over a 3s idle window.
 *
 * Auth-helper limitation: this repo's e2e session helper (signInIfPossible) is
 * credential-based and gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against
 * PROD_URL. When those are absent, the authenticated path skips cleanly (does not
 * fail CI); the unauth-redirect path always runs.
 *
 * Best-effort and non-destructive: it never triggers a sweep (no POST), so prod
 * benchmark data is not polluted; it only asserts the page renders.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Benchmark dashboard reality check", () => {
  test("unauthenticated visit to /admin/benchmark redirects to /login (never blank)", async ({
    page,
  }) => {
    // No session seeded: the page's auth-redirect guard must send the visitor to
    // /login with a ?next back to the dashboard, not render an empty surface.
    await page.goto(`${target.baseUrl}/admin/benchmark`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated /admin/benchmark lands on /login, not a blank dashboard",
    ).toBe(true);
  });

  test("authenticated /admin/benchmark renders summary + backlog OR the empty state cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds — authenticated benchmark path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/benchmark`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/benchmark loads (not 401/blank)").toBe(200);

    // The page is not blank: the title is rendered.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    expect(bodyText.includes("benchmark"), "the benchmark page is not blank").toBe(true);

    // Either the summary cards (with data) OR the explicit empty state is in the
    // DOM, never a silent blank. The page-level container is always present.
    await expect(
      page.getByTestId("benchmark-page"),
      "the benchmark page container mounts",
    ).toBeVisible({ timeout: 8_000 });

    const summary = page.getByTestId("benchmark-summary");
    const empty = page.getByTestId("benchmark-empty");
    const summaryCount = await summary.count();
    const emptyCount = await empty.count();
    expect(
      summaryCount + emptyCount,
      "the summary cards or the explicit empty-state testid is rendered",
    ).toBeGreaterThan(0);

    // When runs exist, the recall card and the backlog section render with
    // non-zero content. When none exist, the empty state spells out the next step.
    if (summaryCount > 0) {
      await expect(
        page.getByTestId("summary-recall"),
        "the recall summary card renders",
      ).toBeVisible();
      await expect(
        page.getByTestId("benchmark-backlog"),
        "the learning-signal backlog section renders",
      ).toBeVisible();
      await expect(
        page.getByTestId("benchmark-trend"),
        "the trend table renders",
      ).toBeVisible();
    } else {
      await expect(empty, "the empty state explains how to trigger a sweep").toContainText(
        /no benchmark runs yet/i,
      );
    }

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/benchmark:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
