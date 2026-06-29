/**
 * Competitive benchmark reality check (/admin/benchmark -> "Versus the competition").
 *
 * The competitive section is the client-facing proof surface: OWASP ZAP + Nuclei
 * scored against the SAME corpus, ground truth and scorer as us, laid head to head,
 * plus our recall improvement over time. This spec proves, at the layer the jest
 * suite cannot reach, that the section is wired to a real API against a real DB and
 * renders cleanly in the browser.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * widget (a 401 or missing testid the unit tests can't see), or a dashboard that
 * blanks instead of redirecting an unauthenticated visitor.
 *
 * Two paths (mirrors benchmark-dashboard.spec.ts):
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank). Runs
 *      unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, and EITHER the
 *      competition section renders with content OR its explicit empty states render,
 *      with ZERO CSP/network failures over a 3s idle window.
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

test.describe("Competitive benchmark reality check", () => {
  test("unauthenticated visit to /admin/benchmark redirects to /login (never blank)", async ({
    page,
  }) => {
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

  test("authenticated competition section renders head-to-head OR explicit empty cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds: authenticated competitive path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/benchmark`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/benchmark loads (not 401/blank)").toBe(200);

    await expect(
      page.getByTestId("benchmark-page"),
      "the benchmark page container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // The competition section only renders when at least one benchmark run exists
    // (the page's runs-present branch). When runs exist, the section is present and
    // either lists head-to-head rows OR spells out the empty state - never a blank.
    const section = page.getByTestId("competition-section");
    const empty = page.getByTestId("benchmark-empty");
    const sectionCount = await section.count();
    const emptyCount = await empty.count();
    expect(
      sectionCount + emptyCount,
      "either the competition section or the no-runs empty state is rendered",
    ).toBeGreaterThan(0);

    if (sectionCount > 0) {
      await expect(section, "the competition section renders").toBeVisible();
      const list = page.getByTestId("competition-list");
      const compEmpty = page.getByTestId("competition-empty");
      expect(
        (await list.count()) + (await compEmpty.count()),
        "the head-to-head list or its explicit empty state renders",
      ).toBeGreaterThan(0);

      // The improvement tile renders either the metric or its explicit empty state.
      const improvement = page.getByTestId("improvement-metric");
      const improvementEmpty = page.getByTestId("improvement-empty");
      expect(
        (await improvement.count()) + (await improvementEmpty.count()),
        "the improvement tile renders the metric or its empty state",
      ).toBeGreaterThan(0);
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
