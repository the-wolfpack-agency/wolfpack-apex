/**
 * Job Code Dossier — deployed-URL reality check.
 *
 * Verifies the per-code dossier renders without blanking and the
 * API returns a sane shape against either a known code from the
 * cache OR a deliberately-unknown code (which should 404 cleanly).
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
const SPEC_NAME = "job-code-dossier-flow";

test.describe("job code dossier — deployed reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping dossier reality check",
  );

  test("unknown code → /api 404 + page renders not-found branch", async ({ page, request }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";
    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn).toBe(true);
      token = await authToken(page);

      const apiRes = await request.get(
        `${target.baseUrl}/api/job-codes/__definitely-not-a-real-code__/dossier`,
        { headers: { authorization: `Bearer ${token}` }, timeout: 30_000 },
      );
      expect(apiRes.status()).toBe(404);
      const body = await apiRes.json().catch(() => ({}));
      expect(body.error).toBe("code_not_found");

      const navRes = await page.goto(
        `${target.baseUrl}/job-codes/__definitely-not-a-real-code__`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      expect(navRes?.status() ?? 0).toBe(200);

      const wrap = page.getByTestId("job-code-dossier-page");
      await expect(wrap).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("dossier-not-found")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("dossier-back-link")).toHaveAttribute("href", "/job-codes");
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

  test("a real code from the catalog opens a dossier with rollups", async ({ page, request }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";
    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn).toBe(true);
      token = await authToken(page);

      /* Pick a real code from the catalog — skip cleanly when the
         cache is cold (the catalog itself can return 503 in that
         environment; we don't fail this test on infra absence). */
      const listRes = await request.get(`${target.baseUrl}/api/job-codes`, {
        headers: { authorization: `Bearer ${token}` },
        timeout: 30_000,
      });
      if (listRes.status() !== 200) {
        result = "skip";
        return;
      }
      const list = await listRes.json();
      const firstCode = Array.isArray(list.codes) && list.codes[0]?.code;
      if (!firstCode) {
        result = "skip";
        return;
      }

      const apiRes = await request.get(
        `${target.baseUrl}/api/job-codes/${encodeURIComponent(firstCode)}/dossier`,
        { headers: { authorization: `Bearer ${token}` }, timeout: 30_000 },
      );
      expect(apiRes.status()).toBe(200);
      const body = await apiRes.json();
      expect(body.dossier?.header?.code).toBeTruthy();
      expect(body.dossier?.rollups).toBeDefined();

      const navRes = await page.goto(
        `${target.baseUrl}/job-codes/${encodeURIComponent(firstCode)}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      expect(navRes?.status() ?? 0).toBe(200);

      await expect(page.getByTestId("code-dossier")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("rollup-spend-ytd")).toBeVisible();
      await expect(page.getByTestId("rollup-receipt-count")).toBeVisible();
    } catch (err) {
      result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: `${SPEC_NAME}-happy`,
        result,
        duration_ms: Date.now() - start,
      });
    }
  });
});
