/**
 * Sites — preview iframe reality check.
 *
 * This is the spec that would have caught commit 9097a47's regression:
 * the detail-page iframe switched from the deployed Vercel URL to an
 * internal /sites/[id]/preview route that rendered only a near-empty
 * SiteBrief stub. 400+ jest tests stayed green; the user spotted it in
 * 5 seconds by eyeballing the iframe vs the Open ↗ link.
 *
 * What this asserts that no other test does:
 *   1. The pixel content inside the detail-page iframe matches the
 *      content behind the Open ↗ link. "Headline parity" — same <h1>
 *      on both surfaces.
 *   2. When preview_url IS set, the iframe MUST NOT show stub phrases
 *      ("Edit this brief in Instinct", "populate the rest",
 *      "Get in touch") that only belong on pre-deploy briefs.
 *   3. A missing-project URL lands on a recognizable not-found state,
 *      not a white/blank screen.
 *
 * Gates:
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD must be set for auth flow.
 *   - SITES_SMOKE_PROJECT_ID must point at a deployed site with
 *     preview_url populated — otherwise the parity check skips
 *     cleanly (missing input, not a product bug).
 *
 * Runs against PROD_URL when set, localhost otherwise. Screenshots
 * land in tests/e2e/screenshots/ for human review after each run.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
  extractHeadline,
  findPreviewStubPhrase,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SMOKE_PROJECT_ID = process.env.SITES_SMOKE_PROJECT_ID ?? "";
const SPEC_NAME = "sites-preview-reality-check";

test.describe("sites — preview iframe reality check", () => {
  test("iframe content matches the deployed URL (the 9097a47 parity bug)", async ({
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
      test.skip(true, "SMOKE_TEST_EMAIL/PASSWORD not set — skipping parity check");
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
        "SITES_SMOKE_PROJECT_ID not set — set it to a deployed site's id to run parity check",
      );
      return;
    }

    try {
      expect(await signInIfPossible(page, target)).toBe(true);
      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await page.screenshot({
        path: "tests/e2e/screenshots/preview-parity-detail.png",
        fullPage: true,
      });

      // 1. Locate the preview iframe on the detail page and pin its src.
      // The detail page intentionally points the iframe at the INTERNAL
      // /sites/[id]/preview route (so draft/deployed/fallback logic lives
      // in one place). The internal route then either iframes the deployed
      // Vercel URL or renders the saved brief.
      const detailIframe = page.locator('iframe[title*="preview" i]').first();
      await expect(detailIframe).toBeVisible({ timeout: 10_000 });
      const detailSrc = await detailIframe.getAttribute("src");
      expect(detailSrc, "detail iframe must have a src").toBeTruthy();
      expect(
        detailSrc,
        "detail iframe must point at /sites/{id}/preview (internal), not a raw URL",
      ).toContain(`/sites/${SMOKE_PROJECT_ID}/preview`);

      // 2. Descend into the internal preview route to read data-preview-source.
      const previewFrame = page.frameLocator('iframe[title*="preview" i]').first();
      const previewRoot = previewFrame.locator("[data-preview-source]").first();
      await expect(previewRoot).toBeAttached({ timeout: 15_000 });
      const previewSource = await previewRoot.getAttribute("data-preview-source");
      expect(
        previewSource,
        "data-preview-source must be one of deployed|draft|fallback_saved",
      ).toMatch(/^(deployed|draft|fallback_saved)$/);

      // 3. Pull the deployed URL out of the project API so we can
      // independently verify headline parity.
      const token = await authToken(page);
      const apiRes = await page.request.get(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(apiRes.ok(), `GET /api/sites/${SMOKE_PROJECT_ID} failed`).toBe(true);
      const apiBody = (await apiRes.json()) as {
        project: { preview_url: string | null; display_name: string };
      };
      const previewUrl = apiBody.project.preview_url;

      if (!previewUrl) {
        // Configured project has no deployed URL yet — emit a clear note
        // and skip the parity half (the stub-phrase guard below still
        // wouldn't apply without preview_url).
        note = `project has no preview_url yet (source=${previewSource})`;
        result = "skip";
        test.skip(true, note);
        return;
      }

      // 4. Detail-side headline — reach into the DEEP iframe the internal
      // preview route mounts when it picks "deployed".
      let detailHeadline = "";
      if (previewSource === "deployed") {
        // The internal preview page mounts a nested iframe whose src IS
        // the deployed Vercel URL. Playwright's frameLocator walks the tree.
        const deployedFrame = previewFrame.frameLocator("iframe").first();
        detailHeadline = await deployedFrame
          .locator("h1, h2")
          .first()
          .innerText({ timeout: 15_000 })
          .catch(() => "");
      } else {
        // Fallback: read the visible text off the internal preview body.
        detailHeadline = await previewFrame
          .locator("h1, h2")
          .first()
          .innerText({ timeout: 10_000 })
          .catch(() => "");
      }

      // 5. Deployed-side headline — open the preview_url directly in a
      // fresh page and capture its <h1>/<h2>.
      const deployedPage = await page.context().newPage();
      await deployedPage.goto(previewUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await deployedPage.screenshot({
        path: "tests/e2e/screenshots/preview-parity-deployed.png",
        fullPage: true,
      });
      const deployedHeadline = await extractHeadline(deployedPage);
      await deployedPage.close();

      // 6. Parity assertion. We compare the first few characters (AI
      // brief edits may rephrase taglines, but the site name / hero
      // heading is load-bearing and must match across surfaces).
      expect(
        detailHeadline.trim().length,
        "detail iframe must render a headline (h1/h2)",
      ).toBeGreaterThan(0);
      expect(
        deployedHeadline.trim().length,
        "deployed URL must render a headline",
      ).toBeGreaterThan(0);

      // Normalize whitespace before comparison — some templates add <br>
      // that collapse differently across rendering surfaces.
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      expect(
        norm(detailHeadline),
        `Headline mismatch — detail iframe shows "${detailHeadline}" but deployed URL shows "${deployedHeadline}". This is the 9097a47 parity bug class.`,
      ).toBe(norm(deployedHeadline));

      // 7. Stub-phrase regression guard. If preview_url is set AND the
      // iframe body still contains stub phrases, the internal preview
      // route is rendering SiteBrief instead of iframing the real site.
      const previewBodyText = await previewFrame
        .locator("body")
        .innerText()
        .catch(() => "");
      const stub = findPreviewStubPhrase(previewBodyText);
      expect(
        stub,
        `Iframe showed stub phrase "${stub}" on a project whose preview_url is "${previewUrl}". This means the internal /sites/${SMOKE_PROJECT_ID}/preview is rendering the SiteBrief stub instead of the deployed site.`,
      ).toBeNull();
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

  test("missing project id shows not-found, not a blank white screen", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    try {
      if (target.email && target.password) {
        // Sign in when we can so we hit the real detail page rather than
        // the login redirect — that path has its own coverage.
        await signInIfPossible(page, target);
      }
      await page.goto(
        `${target.baseUrl}/sites/site_00000000-0000-0000-0000-000000000000`,
        { waitUntil: "networkidle" },
      );
      await page.screenshot({
        path: "tests/e2e/screenshots/preview-missing-project.png",
        fullPage: true,
      });

      const bodyText = (await page.locator("body").innerText().catch(() => "")).trim();
      // The page must not be literally blank. Either the login redirect
      // fires (unauthenticated) or a not-found/archived message appears.
      expect(
        bodyText.length,
        "missing-project page must not render a blank body",
      ).toBeGreaterThan(20);

      const url = page.url();
      const isLoginRedirect = url.includes("/login");
      const hasNotFoundCopy = /not found|archived|404/i.test(bodyText);
      const hasSignInCopy = /sign in/i.test(bodyText);
      expect(
        isLoginRedirect || hasNotFoundCopy || hasSignInCopy,
        `Expected /login redirect OR not-found copy on missing project page. Got URL=${url} bodyStart="${bodyText.slice(0, 160)}"`,
      ).toBe(true);
    } catch (err) {
      result = "fail";
      note = (err as Error).message?.slice(0, 240);
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, null, {
        spec: `${SPEC_NAME}:missing-project`,
        result,
        duration_ms: Date.now() - start,
        note,
      });
    }
  });
});

// Hook for test-scoped Page usage when adding more cases later. Kept as a
// no-op function so the import stays minimal and tsc doesn't complain.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _unusedTypeAnchor(_p: Page) {
  return;
}
