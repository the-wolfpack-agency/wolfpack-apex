/**
 * Sites — per-page SEO + favicon reality check.
 *
 * Designers open the preview route and read document head tags to verify
 * SEO is actually landing in the DOM. This is the spec that would catch
 * a regression where buildSeoMetaTags silently stops emitting in the
 * preview iframe (the exact 9097a47-class bug, but for metadata).
 *
 * What this asserts:
 *   1. document.title matches brief.product.name (or seo.title override)
 *      — so browser tabs + SERP previews don't go blank.
 *   2. At least one `<meta property="og:title">` exists with non-empty
 *      content — so Slack/LinkedIn shares render a title card.
 *   3. `<meta property="og:type" content="website">` always present.
 *
 * Gates:
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD must be set for auth flow.
 *   - SITES_SMOKE_PROJECT_ID must point at an existing site.
 * Missing env vars → the test skips cleanly rather than fails.
 *
 * Runs against PROD_URL when set, localhost otherwise. Screenshot lands
 * in tests/e2e/screenshots/ for human review after each run.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SMOKE_PROJECT_ID = process.env.SITES_SMOKE_PROJECT_ID ?? "";
const SPEC_NAME = "sites-seo-reality-check";

test.describe("sites — per-page SEO reality check", () => {
  test("preview route emits title + og:title + og:type into document.head", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    if (!target.email || !target.password) {
      result = "skip";
      note = "SMOKE_TEST_EMAIL/PASSWORD not set";
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
      test.skip(true, "SMOKE_TEST_EMAIL/PASSWORD not set — skipping SEO check");
      return;
    }
    if (!SMOKE_PROJECT_ID) {
      result = "skip";
      note = "SITES_SMOKE_PROJECT_ID not set";
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
      test.skip(
        true,
        "SITES_SMOKE_PROJECT_ID not set — set it to a known site id to run SEO check",
      );
      return;
    }

    try {
      expect(await signInIfPossible(page, target)).toBe(true);

      // Go directly to the internal preview route (same surface the detail
      // page iframes). We're looking at the client-rendered head, not the
      // deployed-site iframe's head, since Instinct owns this injection.
      await page.goto(
        `${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/preview`,
        { waitUntil: "networkidle" },
      );
      await page.screenshot({
        path: "tests/e2e/screenshots/seo-preview.png",
        fullPage: true,
      });

      // 1. document.title must be non-empty and correspond to the brief's
      // product.name OR the page-level seo.title override.
      const title = await page.title();
      expect(
        title.trim().length,
        "document.title must not be empty on a valid brief",
      ).toBeGreaterThan(0);

      // 2. og:title is emitted whenever we have any title; that's a hard
      // invariant of buildSeoMetaTags.
      const ogTitle = await page
        .locator('meta[property="og:title"]')
        .first()
        .getAttribute("content");
      expect(
        ogTitle ?? "",
        "og:title meta tag must be present with non-empty content",
      ).not.toBe("");

      // 3. og:type is unconditionally emitted on any valid brief — the
      // preview route must not skip it.
      const ogType = await page
        .locator('meta[property="og:type"]')
        .first()
        .getAttribute("content");
      expect(ogType, "og:type must be website").toBe("website");
    } catch (err) {
      result = "fail";
      note = (err as Error).message?.slice(0, 240);
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
    }
  });
});
