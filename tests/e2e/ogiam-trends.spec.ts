/**
 * OGIAM governance drift-trends reality check.
 *
 * Governance has to be operational over time, not a one-shot snapshot. The
 * /admin/ogiam page now carries a trends section: gate-decision volume + would-
 * block mix, red-team pass-rate history, and the ungoverned-AI-surface count, each
 * as a day-bucketed sparkline. This spec proves, at the layer the jest suite
 * cannot reach, that the trends API is wired to a real DB and the section renders
 * cleanly in the browser.
 *
 * The class of bug this defends against: a /api/admin/ogiam/trends endpoint that
 * 200s with the wrong shape (so the section silently shows nothing), or a trends
 * section that 200s but renders a blank widget or trips CSP.
 *
 * Flow:
 *   1. Sign in. Skip cleanly when SMOKE creds are absent.
 *   2. GET /api/admin/ogiam/trends with the bearer token. Assert 200 and the
 *      { workspace_id, window_days, decisions[], redteam[], surfaces[] } shape.
 *      The series may be empty, but each must be an array.
 *   3. Load /admin/ogiam: 200, not blank, the trends grid OR its empty/loading
 *      state is present, and ZERO CSP/network failures during a 3s idle.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD against PROD_URL. Skips cleanly
 * (does not fail CI) when creds are missing.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("OGIAM governance drift-trends reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("trends API returns the trends shape, then the page renders cleanly", async ({
    page,
    request,
  }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing after sign-in");
      return;
    }

    // 1. The trends endpoint backs the section. Assert the contract: a 200 with a
    //    workspace id, a numeric window, and the three series ARRAYS. Empty arrays
    //    are valid (a quiet workspace), but a non-array would blank the section.
    const apiRes = await request.get(
      `${target.baseUrl}/api/admin/ogiam/trends?window=30`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      apiRes.status(),
      `GET /api/admin/ogiam/trends returned ${apiRes.status()}`,
    ).toBe(200);

    const payload = await apiRes.json();
    expect(payload.workspace_id, "workspace_id is present").toBeTruthy();
    expect(typeof payload.window_days, "window_days is numeric").toBe("number");
    expect(Array.isArray(payload.decisions), "decisions is an array").toBe(true);
    expect(Array.isArray(payload.redteam), "redteam is an array").toBe(true);
    expect(Array.isArray(payload.surfaces), "surfaces is an array").toBe(true);

    // 2. The browser renders the page (incl. the trends section) cleanly.
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ogiam`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ogiam loads (not 401/blank)").toBe(200);

    // The trends section is always in the DOM; one of its states (grid / empty /
    // loading / error) must be present, never a silent blank.
    const section = page.getByTestId("ogiam-trends");
    await expect(section, "the governance trends section is rendered").toBeVisible({
      timeout: 8_000,
    });
    const grid = page.getByTestId("ogiam-trends-grid");
    const empty = page.getByTestId("ogiam-trends-empty");
    const loading = page.getByTestId("ogiam-trends-loading");
    const errorState = page.getByTestId("ogiam-trends-error");
    const present =
      (await grid.count()) +
      (await empty.count()) +
      (await loading.count()) +
      (await errorState.count());
    expect(
      present,
      "a trends grid / empty / loading / error state is rendered",
    ).toBeGreaterThan(0);

    // No CSP or network failures during the 3s idle window.
    await page.waitForTimeout(3_000);
    const failures = snapshot();
    expect(
      failures,
      `CSP/network failures on /admin/ogiam:\n${failures
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
