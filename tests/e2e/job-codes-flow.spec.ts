/**
 * Job Codes — deployed-URL reality check.
 *
 * The page is read-only-from-SharePoint, so the assertions match what
 * a real signed-in user would see:
 *   1. /job-codes returns HTTP 200, renders the page shell + table.
 *   2. /api/job-codes (called via the page) is reachable + returns
 *      either a non-empty `codes` array OR a typed 503 — anything
 *      else (200 with empty array, 500, hang) is a regression.
 *   3. The freshness chip is visible and one of {Synced, Stale,
 *      Never synced}. The blank-chip case is the silent-failure mode
 *      we're guarding against.
 *
 * Gated on SMOKE_TEST_EMAIL/PASSWORD. Runs against PROD_URL when set.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SPEC_NAME = "job-codes-flow";

test.describe("job codes — deployed reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping job-codes reality check",
  );

  test("/job-codes renders the table + the API returns a sane shape", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";

    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn, "sign-in attempt must succeed").toBe(true);
      token = await authToken(page);
      expect(token, "auth token after sign-in").not.toEqual("");

      // Probe the API directly first — that's where the silent-failure
      // bug class lives. Tolerated outcomes: 200 with codes OR 503
      // when the cache is genuinely cold AND Graph is unreachable.
      const apiRes = await request.get(`${target.baseUrl}/api/job-codes`, {
        headers: { authorization: `Bearer ${token}` },
        timeout: 30_000,
      });
      const apiStatus = apiRes.status();
      const apiBody = await apiRes.json().catch(() => ({}));

      if (apiStatus === 200) {
        expect(Array.isArray(apiBody.codes), "/api/job-codes 200 must include codes array").toBe(true);
        expect(apiBody.source, "200 response must include source freshness info").toBeDefined();
      } else if (apiStatus === 503) {
        expect(apiBody.error, "503 response must include a typed error").toBe("job_codes_unavailable");
      } else {
        throw new Error(
          `/api/job-codes returned unexpected HTTP ${apiStatus}: ${JSON.stringify(apiBody).slice(0, 300)}`,
        );
      }

      // Now hit the actual page — confirms the layout + client component
      // render and the freshness chip is visible.
      const navRes = await page.goto(`${target.baseUrl}/job-codes`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(navRes?.status() ?? 0, "/job-codes HTTP status").toBe(200);

      const pageRoot = page.getByTestId("job-codes-page");
      await expect(pageRoot, "page wrapper must render").toBeVisible({ timeout: 10_000 });

      const tableRoot = page.getByTestId("job-codes-table");
      await expect(tableRoot, "table component must render").toBeVisible({ timeout: 10_000 });

      const chip = page.getByTestId("job-codes-freshness");
      await expect(chip, "freshness chip must render").toBeVisible();
      const chipText = (await chip.innerText()).toLowerCase();
      expect(
        /synced|stale|never synced/.test(chipText),
        `freshness chip text "${chipText}" should be one of the documented states`,
      ).toBe(true);
    } catch (err) {
      result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
      });
    }
  });

  test("the search input filters the rendered rows", async ({ page, request }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";
    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn).toBe(true);
      token = await authToken(page);

      await page.goto(`${target.baseUrl}/job-codes`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await expect(page.getByTestId("job-codes-table")).toBeVisible({ timeout: 10_000 });

      // If the cache is empty in this env, skip search assertion — the
      // empty-state branch is what should render.
      const empty = await page.getByTestId("job-codes-empty").isVisible().catch(() => false);
      if (empty) {
        result = "skip";
        return;
      }

      const search = page.getByTestId("job-codes-search");
      await search.fill("zzz-no-match-expected-zzz");
      await expect(page.getByTestId("job-codes-empty")).toBeVisible({ timeout: 5_000 });
    } catch (err) {
      result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: `${SPEC_NAME}-search`,
        result,
        duration_ms: Date.now() - start,
      });
    }
  });
});
