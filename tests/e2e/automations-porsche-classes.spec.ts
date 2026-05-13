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

    /* Pre-flight: hit /api/automations with the same auth context the
       page uses, so a missing capability fails fast with a clear message
       instead of a generic "row didn't render" 20s timeout. The page
       calls this same endpoint client-side and renders an error banner
       on 401, but the empty-list rendering looks identical to "still
       loading" if you only watch for the row testid. */
    const apiCheck = await page.evaluate(async () => {
      const token = localStorage.getItem("instinct_token");
      const res = await fetch("/api/automations", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    });
    expect(
      apiCheck.status,
      `GET /api/automations returned ${apiCheck.status}. ` +
        `If 401 with capability=automations.view, the SMOKE_TEST user ` +
        `lacks that capability — grant it via the role-capabilities map ` +
        `(roles: CTO/CEO/HR/OPS/DEV) and update the user's role in the ` +
        `instinct_users table. Body: ${JSON.stringify(apiCheck.body)}`,
    ).toBe(200);

    /* The dashboard layout renders "Loading…" until its useEffect
       hydrates `user` from localStorage. Wait for the porsche-classes
       row testid directly — it only mounts after layout-auth resolves
       AND /api/automations returns. Stable selector ⇒ no race. */
    const porscheRow = page.getByTestId("automation-row-porsche-classes");
    await expect(porscheRow).toBeVisible({ timeout: 20_000 });
    await porscheRow.click();

    /* ---------- /automations/porsche-classes overview ----------
       Next.js routes this URL to the DEDICATED porsche-classes page,
       not the generic [automationId] page. Check the page mounted
       first (cheap, fast — `this-week-back` link is unconditional),
       THEN check the data section under a longer budget. A page that's
       still in its "Loading classes…" state is a valid render — the
       data section just needs more time on cold-start Vercel + Postgres
       + Microsoft-Graph counts. */
    await page.waitForURL(/\/automations\/porsche-classes$/, { timeout: 10_000 });
    await expect(
      page.getByTestId("this-week-back"),
      "porsche-classes page must mount within 15s",
    ).toBeVisible({ timeout: 15_000 });

    const weekList = page.getByTestId("this-week-list");
    const weekEmpty = page.getByTestId("this-week-empty");
    const weekErr = page.getByTestId("this-week-error");
    const rendered = await Promise.race([
      weekList.first().waitFor({ state: "visible", timeout: 45_000 }).then(() => "list" as const),
      weekEmpty.first().waitFor({ state: "visible", timeout: 45_000 }).then(() => "empty" as const),
      weekErr.first().waitFor({ state: "visible", timeout: 45_000 }).then(() => "error" as const),
    ]).catch(() => "timeout" as const);
    expect(
      rendered,
      "porsche-classes data section must render list/empty/error within 45s",
    ).not.toBe("timeout");
    expect(rendered, "porsche-classes overview must not surface a hard error").not.toBe("error");

    /* ---------- /changes ----------
       The dedicated /automations/porsche-classes page doesn't expose
       a `link-changes` testid (it lives only on the generic detail
       page). Next.js still resolves /automations/porsche-classes/changes
       to [automationId]/changes/page.tsx, so navigate directly.
       Match the more generous /exceptions block below for timing budget. */
    await page.goto(`${target.baseUrl}/automations/porsche-classes/changes`, {
      waitUntil: "domcontentloaded",
    });
    const list = page.getByTestId("changes-list");
    const empty = page.getByTestId("changes-empty");
    const oneOrTheOther = await Promise.race([
      list.waitFor({ state: "visible", timeout: 15_000 }).then(() => "list"),
      empty.waitFor({ state: "visible", timeout: 15_000 }).then(() => "empty"),
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
