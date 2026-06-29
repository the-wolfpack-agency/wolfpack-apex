/**
 * Production release gate reality check (/admin/deployment).
 *
 * The release gate is the operator/CLIENT-facing answer to "what is blocking a
 * deploy to production right now, and what can I promote in one click?" This
 * spec proves, at the layer the jest suite cannot reach, that the gate section
 * renders in a real browser against the real app and that the page redirects an
 * unauthenticated visitor instead of blanking.
 *
 * The class of bug this defends against: a page that 200s but renders a blank
 * gate (a 401 the unit tests can't see), or a dashboard that blanks instead of
 * redirecting an unauthenticated visitor, or a CSP violation that kills the
 * promote button.
 *
 * Two paths (mirrors benchmark-dashboard.spec.ts):
 *   1. Unauthenticated visit -> redirected to /login (never a silent blank).
 *      Runs unconditionally; needs no creds.
 *   2. Authenticated load (gated on SMOKE creds) -> 200, not blank, the
 *      release-gate section mounts and shows EITHER blocking rows OR the
 *      explicit "all changes are live" empty state OR the honest-degrade
 *      warning, with ZERO CSP/network failures over a 3s idle window.
 *
 * Non-destructive: it never clicks Promote (no merge), so production is never
 * mutated; it only asserts the gate renders.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("Production release gate reality check", () => {
  test("unauthenticated visit to /admin/deployment redirects to /login (never blank)", async ({
    page,
  }) => {
    await page.goto(`${target.baseUrl}/admin/deployment`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await page
      .waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 })
      .catch(() => null);

    expect(
      page.url().includes("/login"),
      "unauthenticated /admin/deployment lands on /login, not a blank dashboard",
    ).toBe(true);
  });

  test("authenticated /admin/deployment renders the release-gate section (rows, empty, or degrade) cleanly", async ({
    page,
  }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) {
      test.skip(true, "no SMOKE creds - authenticated release-gate path skipped (see file header)");
      return;
    }

    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/deployment`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/deployment loads (not 401/blank)").toBe(200);

    // The page is not blank.
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    expect(bodyText.includes("release"), "the release gate is on the page").toBe(true);

    // The gate section always mounts.
    await expect(
      page.getByTestId("release-gate-section"),
      "the release-gate section container mounts",
    ).toBeVisible({ timeout: 8_000 });

    // Exactly one of: blocking rows, the explicit empty state, or the honest
    // degrade warning is shown - never a silent blank.
    const rows = page.getByTestId("release-gate-rows");
    const empty = page.getByTestId("release-gate-empty");
    const degraded = page.getByTestId("release-gate-degraded");
    const total =
      (await rows.count()) + (await empty.count()) + (await degraded.count());
    expect(
      total,
      "the gate shows blocking rows, the empty state, or the degrade warning",
    ).toBeGreaterThan(0);

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/deployment:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
