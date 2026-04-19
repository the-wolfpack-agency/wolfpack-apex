/**
 * Sites — upload reality check.
 *
 * The test the designer would have caught manually: drop a wireframe
 * with distinctive, recognizable text; assert the extracted brief
 * preview actually contains words from the uploaded image.
 *
 * If the extractor produces pure boilerplate ("test11" / "Get in
 * touch"), that IS the bug — this test fails loudly with the actual
 * rendered text in the error message, not a generic "mismatch".
 *
 * Gates:
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD must be set (real auth flow).
 *   - ANTHROPIC_API_KEY must be configured server-side for vision
 *     extraction; otherwise the 503 banner surfaces and we skip.
 *
 * Runs against PROD_URL when set. Fixture images are generated on
 * demand via tests/e2e/fixtures/generate-fixtures.ts — no new runtime
 * deps required.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";
import { ensureFixture } from "./fixtures/generate-fixtures";

const target = resolveSmokeTarget();
const SPEC_NAME = "sites-upload-reality-check";

/**
 * Distinctive uppercase words baked into each fixture — the extractor
 * should echo at least ONE of these into the produced brief. Any
 * fixture whose extraction contains none of these words means the
 * vision path silently fell back to boilerplate.
 */
const FIXTURE_WORDS = ["ACME", "RACING", "PARTNER"];

async function hasStubFallbackText(iframeBodyText: string): Promise<boolean> {
  const stubs = ["test11", "Get in touch", "Edit this brief in Instinct"];
  return stubs.some((s) => iframeBodyText.toLowerCase().includes(s.toLowerCase()));
}

test.describe("sites — wireframe upload reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping wireframe upload reality check",
  );

  test("uploaded wireframe text survives into the extracted brief", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    try {
      expect(await signInIfPossible(page, target)).toBe(true);
      await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

      // Fixture file: large black "ACME RACING" on white. Generated
      // deterministically; zero runtime deps. The PNG is self-decoding
      // and human-readable by vision models.
      const fixturePath = ensureFixture(
        "wireframe-acme-racing.png",
        "ACME RACING",
      );
      expect(fs.existsSync(fixturePath), "fixture must exist").toBe(true);

      // Drop the fixture via the dropzone's hidden file input.
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles(fixturePath);

      // Either the review card shows (happy) or the error banner fires
      // (503 / 413 / 415). We tolerate the "not configured" skip case.
      const review = page.getByTestId("wireframe-extract-review");
      const errorBanner = page.getByTestId("wireframe-error-banner");

      const seenReview = await review
        .waitFor({ state: "visible", timeout: 45_000 })
        .then(() => true)
        .catch(() => false);
      if (!seenReview) {
        const errVisible = await errorBanner.isVisible().catch(() => false);
        if (errVisible) {
          const errText = (await errorBanner.innerText()).toLowerCase();
          if (/not configured|anthropic_api_key|admin/i.test(errText)) {
            result = "skip";
            note = "ANTHROPIC_API_KEY not configured server-side";
            test.skip(true, `Vision extractor not configured: ${errText}`);
            return;
          }
          throw new Error(`Wireframe upload error banner: ${errText}`);
        }
        throw new Error(
          "Neither wireframe-extract-review nor wireframe-error-banner appeared within 45s of upload",
        );
      }

      await page.screenshot({
        path: "tests/e2e/screenshots/upload-reality-review.png",
        fullPage: true,
      });

      // The review card's rendered brief content is the reality-check
      // surface. Grab the whole review pane's text and search for any
      // fixture word. We accept partial / cased mismatches.
      const reviewText = await review.innerText();
      const upperReview = reviewText.toUpperCase();
      const matches = FIXTURE_WORDS.filter((w) => upperReview.includes(w));

      // Fallback-stub detector — if ANY stub phrase made it into the
      // review card, the extractor isn't actually reading the image.
      const hasStub = await hasStubFallbackText(reviewText);
      expect(
        hasStub,
        `Extracted brief contains boilerplate stub text (Get in touch / test11 / "Edit this brief in Instinct"). Review pane text started: "${reviewText.slice(0, 240)}"`,
      ).toBe(false);

      expect(
        matches.length,
        `Extracted brief contains NONE of the fixture's distinctive words (${FIXTURE_WORDS.join(", ")}). This means the vision extractor fell back to boilerplate. Review pane text started: "${reviewText.slice(0, 240)}"`,
      ).toBeGreaterThan(0);
    } catch (err) {
      result = "fail";
      note = (err as Error).message?.slice(0, 240);
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, await authToken(page).catch(() => ""), {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note,
      });
    }
  });

  test("multi-file upload produces a multi-page brief (when feature lands)", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    try {
      expect(await signInIfPossible(page, target)).toBe(true);
      await page.goto(`${target.baseUrl}/sites/new`, { waitUntil: "networkidle" });

      // Feature-gate: if the file input doesn't accept `multiple`, the
      // multi-frame extractor isn't wired yet (it's one of the parallel
      // streams still in flight at spec-authoring time). Skip cleanly.
      const input = page.locator('input[type="file"]').first();
      const acceptsMultiple = await input.evaluate(
        (el) => (el as HTMLInputElement).multiple === true,
      );
      if (!acceptsMultiple) {
        result = "skip";
        note = "input[type=file] is not multiple — multi-frame feature not landed yet";
        test.skip(
          true,
          "Multi-file uploader not wired yet — skipping until multi-frame extractor lands",
        );
        return;
      }

      const home = ensureFixture("wireframe-acme-home.png", "ACME");
      const partner = ensureFixture("wireframe-acme-partner.png", "PARTNER");

      await input.setInputFiles([home, partner]);

      // Wait for review OR error banner like the single-file case.
      const review = page.getByTestId("wireframe-extract-review");
      const errorBanner = page.getByTestId("wireframe-error-banner");

      const seenReview = await review
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!seenReview) {
        const errVisible = await errorBanner.isVisible().catch(() => false);
        if (errVisible) {
          const errText = await errorBanner.innerText();
          if (/not configured|anthropic_api_key/i.test(errText)) {
            result = "skip";
            note = "ANTHROPIC_API_KEY not configured server-side";
            test.skip(true, `Vision extractor not configured: ${errText}`);
            return;
          }
          throw new Error(`Multi-frame upload error banner: ${errText}`);
        }
        throw new Error(
          "Multi-frame review did not appear within 60s — feature regression or capacity issue",
        );
      }

      await page.screenshot({
        path: "tests/e2e/screenshots/upload-reality-multi.png",
        fullPage: true,
      });

      // Query the brief through the API if the extractor pushes it to a
      // draft; otherwise the review pane itself should show multi-page
      // structure. Fetch the extracted brief via the review card text
      // and require BOTH fixture words.
      const reviewText = (await review.innerText()).toUpperCase();
      const homeMatches = reviewText.includes("ACME");
      const partnerMatches = reviewText.includes("PARTNER");
      expect(
        homeMatches && partnerMatches,
        `Expected both "ACME" and "PARTNER" to survive multi-file extraction, got ACME=${homeMatches} PARTNER=${partnerMatches}. Review text started: "${reviewText.slice(0, 240)}"`,
      ).toBe(true);
    } catch (err) {
      result = "fail";
      note = (err as Error).message?.slice(0, 240);
      throw err;
    } finally {
      await recordRealityCheckRun(
        request,
        target,
        await authToken(page).catch(() => ""),
        {
          spec: `${SPEC_NAME}:multi-frame`,
          result,
          duration_ms: Date.now() - start,
          note,
        },
      );
    }
  });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _unusedTypeAnchor(_p: Page) {
  return;
}
