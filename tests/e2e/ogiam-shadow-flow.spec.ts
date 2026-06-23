/**
 * OGIAM decision explorer reality check.
 *
 * OGIAM is the deterministic AI authorization gate. In shadow (monitor) mode it
 * records what it WOULD decide for every AI action without blocking. The admin
 * decision explorer at /admin/ogiam is where a human reads that evidence stream.
 * This spec proves, at the layer the jest suite cannot reach, that the explorer
 * is wired to a real API against a real DB and renders cleanly in the browser.
 *
 * The class of bug this defends against: a /api/admin/ogiam/decisions endpoint
 * that 200s with the wrong shape (so the explorer silently shows nothing), or an
 * /admin/ogiam page that 200s but renders a blank widget or trips CSP, the kind
 * of failure a 401 or a missing testid would hide from our unit tests.
 *
 * Flow:
 *   1. Sign in. Skip cleanly when SMOKE creds are absent.
 *   2. GET /api/admin/ogiam/decisions with the bearer token. Assert 200 and the
 *      { workspace_id, summary, decisions: [...] } shape. decisions may be empty,
 *      but it must be an array, and summary must carry numeric totals.
 *   3. Load /admin/ogiam in the browser: 200, not blank, the list or empty-state
 *      testid is present, and ZERO CSP/network failures during a 3s idle.
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

test.describe("OGIAM decision explorer, shadow-mode reality check", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("decisions API returns the explorer shape, then the page renders cleanly", async ({
    page,
    request,
  }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing after sign-in");
      return;
    }

    // 1. The decisions endpoint backs the explorer. Assert the contract: a 200
    //    with a workspace id, a numeric summary, and a decisions ARRAY. An empty
    //    array is valid (a quiet workspace), but a non-array or a missing summary
    //    would blank the explorer, so we assert the shape precisely.
    const apiRes = await request.get(
      `${target.baseUrl}/api/admin/ogiam/decisions`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      apiRes.status(),
      `GET /api/admin/ogiam/decisions returned ${apiRes.status()}`,
    ).toBe(200);

    const payload = await apiRes.json();
    expect(payload.workspace_id, "workspace_id is present").toBeTruthy();
    expect(
      Array.isArray(payload.decisions),
      "decisions is an array (may be empty)",
    ).toBe(true);
    expect(payload.summary, "summary block is present").toBeTruthy();
    expect(
      typeof payload.summary.total,
      "summary.total is numeric",
    ).toBe("number");
    expect(
      typeof payload.summary.would_block,
      "summary.would_block is numeric",
    ).toBe("number");
    // The shadow metric can never exceed the total decisions counted.
    expect(payload.summary.would_block).toBeLessThanOrEqual(
      payload.summary.total,
    );

    // 2. The browser renders the explorer page cleanly.
    const snapshot = collectConsoleAndNetworkFailures(page);
    const nav = await page.goto(`${target.baseUrl}/admin/ogiam`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(nav?.status(), "/admin/ogiam loads (not 401/blank)").toBe(200);

    const bodyText = (
      await page.locator("body").innerText().catch(() => "")
    ).toLowerCase();
    expect(
      bodyText.includes("ai gateway") || bodyText.includes("decisions"),
      "the OGIAM explorer page is not blank",
    ).toBe(true);

    // Either the decisions list or the explicit empty state must be in the DOM,
    // never a silent blank. One of the two testids is always present.
    const list = page.getByTestId("ogiam-decisions-list");
    const empty = page.getByTestId("ogiam-decisions-empty");
    const listCount = await list.count();
    const emptyCount = await empty.count();
    expect(
      listCount + emptyCount,
      "the decisions list or the empty-state testid is rendered",
    ).toBeGreaterThan(0);

    // 4. The signing self-test control: clicking it probes the signing backend
    //    and renders a result region. The outcome (verified / configured /
    //    not-configured) depends on whether Key Vault env is set on the target,
    //    so we assert only that the RESULT REGION appears, never a specific
    //    signing state, and we never hard-fail on the signing outcome. The
    //    button is capability-gated; if it is not present on this target we skip
    //    this leg rather than fail the contract leg above.
    const selfTestButton = page.getByTestId("ogiam-signing-selftest-button");
    if ((await selfTestButton.count()) > 0) {
      await selfTestButton.click();
      const selfTestResult = page.getByTestId("ogiam-signing-selftest-result");
      await expect(
        selfTestResult,
        "the signing self-test result region appears after clicking the control",
      ).toBeVisible({ timeout: 8_000 });
    }

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
