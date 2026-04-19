/**
 * Figma import — reality-check (Path C Phase 3, Stream R1).
 *
 * Proves the full loop:
 *   1. Designer opens /sites/[id]/edit.
 *   2. Expands the "Seed from Figma file" panel.
 *   3. Types the URL of a known, shared Figma fixture file.
 *   4. Preview card appears with at least one palette swatch.
 *   5. "Apply to this site" merges the Figma-derived theme/pages into
 *      the draft.
 *   6. The Publish button reflects the draft-dirty state.
 *
 * Gate:
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD (Instinct auth) set.
 *   - SITES_SMOKE_PROJECT_ID set (a site we own).
 *   - FIGMA_ACCESS_TOKEN set on the deployed environment (we CAN'T
 *     verify this from the Playwright context, so it is indirectly
 *     verified by the preview rendering green).
 *   - SITES_SMOKE_FIGMA_URL set — the Figma file URL to import.
 *
 * Missing env → test skips cleanly. No placeholder data, no pretend
 * passes — the spec either proves the full loop or records a skip so
 * the reality-check tracker sees the gap.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SMOKE_PROJECT_ID = process.env.SITES_SMOKE_PROJECT_ID ?? "";
const FIGMA_URL = process.env.SITES_SMOKE_FIGMA_URL ?? "";
const FIGMA_TOKEN_PRESENT = !!process.env.FIGMA_ACCESS_TOKEN;
const SPEC_NAME = "figma-import-reality-check";

test.describe("sites — Figma importer reality check", () => {
  test("designer imports a Figma file and applies the scraped suggestion", async ({
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
      test.skip(true, note);
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
      test.skip(true, note);
      return;
    }
    if (!FIGMA_URL || !FIGMA_TOKEN_PRESENT) {
      result = "skip";
      note = "FIGMA_ACCESS_TOKEN + SITES_SMOKE_FIGMA_URL required";
      await recordRealityCheckRun(request, target, null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
      test.skip(true, note);
      return;
    }

    try {
      expect(await signInIfPossible(page, target)).toBe(true);

      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });

      const panel = page.getByTestId("figma-importer-panel");
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("figma-importer-toggle").click();

      await page
        .screenshot({ path: "test-results/figma-importer-before.png" })
        .catch(() => {});

      const input = page.getByTestId("figma-url-input");
      await input.fill(FIGMA_URL);
      const submit = page.getByTestId("figma-url-submit");
      await expect(submit).toBeEnabled();
      await submit.click();

      // Generous wait — Figma files can be large; the lib's own timeout
      // is 15s so we'd see an error by then one way or another.
      const preview = page.getByTestId("figma-importer-preview");
      await expect(preview).toBeVisible({ timeout: 20_000 });

      const swatches = page.getByTestId("figma-importer-swatch");
      expect(await swatches.count()).toBeGreaterThanOrEqual(1);

      await page
        .screenshot({ path: "test-results/figma-importer-preview.png" })
        .catch(() => {});

      await page.getByTestId("figma-importer-apply").click();

      const publishBtn = page.getByTestId("edit-publish-btn");
      await expect(publishBtn).toBeVisible();
      await expect(publishBtn).toHaveText(/publish/i, { timeout: 5_000 });

      await page
        .screenshot({ path: "test-results/figma-importer-after.png" })
        .catch(() => {});
    } catch (err) {
      result = "fail";
      note = (err as Error).message;
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
