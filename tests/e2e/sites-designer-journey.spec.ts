/**
 * Sites — end-to-end designer journey reality check.
 *
 * The single flow that answers "is this ready for clients?". Takes
 * the path a real designer (Max, Meghan) walks every day:
 *
 *   1. Sign in
 *   2. Open an existing site (list → first card)
 *   3. Drop a wireframe and see extracted content
 *   4. Open the prompt editor, tweak the hero headline
 *   5. Confirm the preview iframe updates WITH the new text visible
 *   6. (Optional, gated) hit Publish and wait for deploy; verify the
 *      deployed URL actually reflects the change
 *   7. Screenshot every major step
 *
 * This spec is deliberately tolerant — non-deterministic AI may phrase
 * things differently each run, so we assert on "unique probe token"
 * strings the AI has to preserve verbatim for the edit to be
 * meaningful.
 *
 * Deploy gate: the Publish step only triggers a real deploy when
 * E2E_ALLOW_DEPLOY=1. Without that opt-in we stop at step 5 — the
 * pixel-level edit chain through the iframe is the reality check.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";
import { ensureFixture } from "./fixtures/generate-fixtures";

const target = resolveSmokeTarget();
const SPEC_NAME = "sites-designer-journey";
const ALLOW_DEPLOY = process.env.E2E_ALLOW_DEPLOY === "1";

async function firstProjectId(page: Page, baseUrl: string): Promise<string | null> {
  const token = await authToken(page);
  if (!token) return null;
  const r = await page.request.get(`${baseUrl}/api/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok()) return null;
  const data = (await r.json()) as { projects: Array<{ id: string }> };
  return data.projects.length > 0 ? data.projects[0].id : null;
}

test.describe("sites — designer journey reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping designer journey",
  );

  test("full flow: sign in → edit prompt → preview reflects the new tagline", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let note: string | undefined;

    try {
      // Step 1 — sign in.
      expect(await signInIfPossible(page, target)).toBe(true);
      await page.screenshot({
        path: "tests/e2e/screenshots/journey-01-signed-in.png",
        fullPage: true,
      });

      // Step 2 — go to sites, take first project.
      const id = await firstProjectId(page, target.baseUrl);
      if (!id) {
        result = "skip";
        note = "No sites in account — cannot run designer journey";
        test.skip(true, "No sites exist — seed a site before running designer journey");
        return;
      }

      // Step 3 — open detail page, take screenshot.
      await page.goto(`${target.baseUrl}/sites/${id}`, { waitUntil: "networkidle" });
      await page.screenshot({
        path: "tests/e2e/screenshots/journey-02-detail.png",
        fullPage: true,
      });

      // Step 4 — drop a wireframe so the designer sees vision extraction
      // working live. Tolerate the "AI not configured" 503 cleanly.
      const fixturePath = ensureFixture(
        "wireframe-journey.png",
        "PARTNER",
      );
      const input = page.locator('input[type="file"]').first();
      await input.setInputFiles(fixturePath);

      const reviewOrError = await Promise.race([
        page
          .getByTestId("wireframe-extract-review")
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => "review"),
        page
          .getByTestId("wireframe-error-banner")
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => "error"),
      ]).catch(() => "timeout");

      if (reviewOrError === "error") {
        const errText = await page
          .getByTestId("wireframe-error-banner")
          .innerText()
          .catch(() => "");
        if (/not configured|anthropic_api_key/i.test(errText)) {
          // Fall through to the editor portion — vision is the optional
          // part of this journey. We still want to prove the edit loop.
          note = `vision skipped: ${errText.slice(0, 80)}`;
        } else {
          throw new Error(`Unexpected wireframe error: ${errText}`);
        }
      }
      await page.screenshot({
        path: "tests/e2e/screenshots/journey-03-extracted.png",
        fullPage: true,
      });

      // Step 5 — jump to the prompt editor.
      await page.goto(`${target.baseUrl}/sites/${id}/edit`, { waitUntil: "networkidle" });
      const chat = page.getByTestId("edit-chat-pane");
      const previewPane = page.getByTestId("edit-preview-pane");
      const iframe = page.getByTestId("edit-preview-iframe");
      await expect(chat).toBeVisible({ timeout: 15_000 });
      await expect(previewPane).toBeVisible();
      await expect(iframe).toBeVisible();

      await page.screenshot({
        path: "tests/e2e/screenshots/journey-04-editor.png",
        fullPage: true,
      });

      // Step 6 — send a prompt with a unique probe token. The AI MUST
      // echo this exact string into the hero; otherwise the edit loop
      // is broken (or the brief isn't rendered into the iframe).
      const probe = `Journey Probe ${Date.now()}`;
      await page.getByTestId("edit-prompt-input").fill(
        `Change the hero heading on the homepage to exactly "${probe}".`,
      );
      await page.getByTestId("edit-send-btn").click();

      // Publish enables once a patch applies — this is the non-negotiable
      // edge: no patch, no preview refresh, no journey.
      await expect(page.getByTestId("edit-publish-btn")).not.toBeDisabled({
        timeout: 45_000,
      });
      await expect(iframe).toHaveAttribute("src", /draft=/);

      // Step 7 — reality check: the iframe MUST show the probe text.
      // If it doesn't, the draft → base64 → preview chain is broken.
      const frame = await iframe.contentFrame();
      expect(frame, "edit preview iframe must have a contentFrame").not.toBeNull();
      await expect(frame!.getByText(probe)).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: "tests/e2e/screenshots/journey-05-preview-updated.png",
        fullPage: true,
      });

      // Step 8 — deploy gate. Without E2E_ALLOW_DEPLOY=1 we stop here.
      if (!ALLOW_DEPLOY) {
        note = note ?? "deploy step skipped (E2E_ALLOW_DEPLOY != 1)";
        return;
      }

      // Step 9 — hit Publish, poll for ready, verify deployed URL shows
      // the probe text. 3-minute budget for a real deploy.
      await page.getByTestId("edit-publish-btn").click();
      const token = await authToken(page);
      const deadline = Date.now() + 180_000;
      let deployed = false;
      let previewUrl: string | null = null;
      while (Date.now() < deadline) {
        const r = await page.request.get(`${target.baseUrl}/api/sites/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok()) {
          const data = (await r.json()) as {
            project: { status: string; preview_url: string | null };
          };
          previewUrl = data.project.preview_url;
          if (data.project.status === "ready" && previewUrl) {
            deployed = true;
            break;
          }
        }
        await page.waitForTimeout(10_000);
      }
      expect(deployed, "site must reach status=ready with preview_url within 3min").toBe(
        true,
      );

      // Confirm the deployed URL actually shows the probe text.
      const deployedPage = await page.context().newPage();
      await deployedPage.goto(previewUrl!, {
        waitUntil: "networkidle",
        timeout: 45_000,
      });
      await deployedPage.screenshot({
        path: "tests/e2e/screenshots/journey-06-deployed.png",
        fullPage: true,
      });
      const deployedBody = await deployedPage.locator("body").innerText().catch(() => "");
      await deployedPage.close();
      expect(
        deployedBody.includes(probe),
        `Deployed URL did not include probe "${probe}". The edit saved and the deploy finished, but the deployed content didn't update. Deployed body started: "${deployedBody.slice(0, 240)}"`,
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
          spec: SPEC_NAME,
          result,
          duration_ms: Date.now() - start,
          note,
        },
      );
    }
  });
});
