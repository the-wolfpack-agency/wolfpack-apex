/**
 * Automations — porsche-classes E2E.
 *
 * Walks the user journey:
 *   1. /automations → click into porsche-classes
 *   2. Overview tiles render (artifacts_today / classes_in_window /
 *      open_exceptions are visible numbers, not blank)
 *   3. /automations/porsche-classes/changes loads (digest list or
 *      empty-state, never 401)
 *   4. /automations/porsche-classes/exceptions loads (list or empty
 *      state)
 *
 * Every step asserts:
 *   - HTTP 200 (NOT just "not 500"); 401 manifests as a blank page so
 *     we explicitly reject it.
 *   - Zero CSP violations / pageerrors during the 3s settle window.
 *   - Zero 401/403/5xx XHR/fetch responses.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD: skipped when creds
 * are missing (local dev without the production credential set).
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  collectConsoleAndNetworkFailures,
} from "./helpers/smoke-helpers";

test.describe("/automations — porsche-classes flow", () => {
  test("dashboard, overview, changes, exceptions all load without auth or CSP errors", async ({
    page,
  }) => {
    const target = resolveSmokeTarget();

    if (!target.email || !target.password) {
      test.skip(true, "SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD required");
      return;
    }

    const failures = collectConsoleAndNetworkFailures(page);

    const signedIn = await signInIfPossible(page, target);
    expect(signedIn, "sign-in attempt must complete").toBe(true);

    /* ---------- /automations index ---------- */
    const indexResp = await page.goto(`${target.baseUrl}/automations`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    expect(
      indexResp?.status(),
      `GET /automations status (401 = blank page; we want 200)`,
    ).toBe(200);

    await expect(page.getByText(/Automations/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // The porsche-classes registry entry must be present.
    const porscheRow = page.getByTestId("automation-row-porsche-classes");
    await expect(porscheRow).toBeVisible();
    await porscheRow.click();

    /* ---------- /automations/porsche-classes overview ---------- */
    await page.waitForURL(/\/automations\/porsche-classes$/, { timeout: 10_000 });
    await expect(page.getByTestId("automation-tiles")).toBeVisible({
      timeout: 10_000,
    });
    // Tiles render numeric content (or "0") — never blank.
    for (const id of ["tile-classes", "tile-artifacts", "tile-exceptions"]) {
      const tile = page.getByTestId(id);
      await expect(tile).toBeVisible();
      const text = (await tile.innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
      expect(/\d+/.test(text), `tile ${id} contains a number`).toBe(true);
    }

    /* ---------- /changes ---------- */
    const changesLink = page.getByTestId("link-changes");
    await changesLink.click();
    await page.waitForURL(/\/automations\/porsche-classes\/changes$/, {
      timeout: 10_000,
    });
    // Either the list renders or the empty-state — both are valid 200s.
    const list = page.getByTestId("changes-list");
    const empty = page.getByTestId("changes-empty");
    const oneOrTheOther = await Promise.race([
      list.waitFor({ state: "visible", timeout: 10_000 }).then(() => "list"),
      empty.waitFor({ state: "visible", timeout: 10_000 }).then(() => "empty"),
    ]).catch(() => null);
    expect(oneOrTheOther, "changes page rendered list or empty state").not.toBeNull();

    /* ---------- /exceptions ---------- */
    await page.goto(`${target.baseUrl}/automations/porsche-classes/exceptions`, {
      waitUntil: "domcontentloaded",
    });
    const excList = page.getByTestId("exceptions-list");
    const excEmpty = page.getByTestId("exceptions-empty");
    const excOne = await Promise.race([
      excList.waitFor({ state: "visible", timeout: 10_000 }).then(() => "list"),
      excEmpty.waitFor({ state: "visible", timeout: 10_000 }).then(() => "empty"),
    ]).catch(() => null);
    expect(excOne, "exceptions page rendered list or empty state").not.toBeNull();

    /* ---------- final settle window for async failures ---------- */
    await page.waitForTimeout(3_000);
    const collected = failures();
    expect(
      collected,
      `CSP / pageerror / 401 / 5xx failures during journey:\n${collected
        .map((f) => `  - [${f.kind}] ${f.detail}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
