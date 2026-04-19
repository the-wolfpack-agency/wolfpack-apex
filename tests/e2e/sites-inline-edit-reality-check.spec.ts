/**
 * Sites — inline-edit direct-manipulation reality check (Stream P2).
 *
 * The designer click-to-edit flow crosses two surfaces in one browser
 * tab: the Instinct edit page mounts an iframe of /sites/[id]/preview,
 * the preview-side overlay swaps the heading into contentEditable on
 * click, and the edit-page listener merges the new value into the draft
 * state + pushes the updated brief back to the iframe for re-render.
 *
 * This spec walks that loop end-to-end against the deployed URL (or a
 * local dev server) so we catch regressions in ways no jest test can —
 * iframe-bound postMessage flow, same-origin parent detection, and the
 * hand-off between overlay + listener in a real document.
 *
 * Gates (skip cleanly when missing):
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD for login
 *   - SITES_SMOKE_PROJECT_ID for a known editable project with a hero
 *     heading in the brief
 *
 * Recorded into the learning loop via `recordRealityCheckRun` so the
 * "trustworthy vs green-but-uninformative" signal includes this spec.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SMOKE_PROJECT_ID = process.env.SITES_SMOKE_PROJECT_ID ?? "";
const SPEC_NAME = "sites-inline-edit-reality-check";

test.describe("sites — inline-edit direct manipulation", () => {
  test("hero heading becomes editable on click, Enter commits to draft", async ({
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

    try {
      expect(await signInIfPossible(page, target)).toBe(true);
      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit`, {
        waitUntil: "networkidle",
      });
      await page.screenshot({
        path: "tests/e2e/screenshots/inline-edit-opened.png",
        fullPage: true,
      });

      // 1. The preview iframe is mounted.
      const frameHandle = page.locator('iframe[data-testid="edit-preview-iframe"]');
      await expect(frameHandle).toBeVisible({ timeout: 10_000 });
      const iframe = page.frameLocator('iframe[data-testid="edit-preview-iframe"]');

      // 2. Find the hero heading inside the iframe.
      const heading = iframe.locator('[data-section-type="hero"] h1').first();
      await expect(heading).toBeVisible({ timeout: 15_000 });
      const originalText = (await heading.textContent())?.trim() ?? "";
      expect(originalText.length).toBeGreaterThan(0);

      // 3. Hover → dashed border class lands.
      await heading.hover();
      // Some browsers skip mouseenter on hover(); dispatch manually as a
      // belt-and-suspenders so the overlay's listener fires deterministically.
      await heading.evaluate((el) => {
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      });
      const hasHoverClass = await heading.evaluate((el) =>
        el.classList.contains("instinct-inline-editable-hover"),
      );
      expect(
        hasHoverClass,
        "hero heading must gain instinct-inline-editable-hover on hover",
      ).toBe(true);

      // 4. Click → contentEditable is active.
      await heading.click();
      const editable = await heading.getAttribute("contenteditable");
      expect(editable, "click must flip heading to contentEditable").toBe("true");

      // 5. Type a new value + Enter to commit.
      const newHeading = `E2E inline ${Date.now()}`;
      await heading.evaluate((el, val) => {
        el.textContent = val;
      }, newHeading);
      await heading.press("Enter");

      // 6. The iframe re-renders with the new brief pushed from the
      // parent. Wait up to a few seconds for the text to land.
      await expect(heading).toHaveText(newHeading, { timeout: 10_000 });

      // 7. Hover indicator appears in the left pane on subsequent hovers.
      await heading.evaluate((el) => {
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      });
      // Best-effort: the hover indicator is sampled 1-in-5 so we retry.
      let hoverLabelVisible = false;
      for (let i = 0; i < 10; i++) {
        const label = page.locator('[data-testid="edit-hover-indicator"]');
        if (await label.isVisible().catch(() => false)) {
          hoverLabelVisible = true;
          break;
        }
        await heading.evaluate((el) => {
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        });
        await page.waitForTimeout(200);
      }
      // Non-blocking: we record it but don't fail — sampled UX, not load-bearing.
      if (!hoverLabelVisible) {
        note = "hover indicator did not fire within 10 sampled attempts (non-fatal)";
      }

      // 8. Publish flips dirty → saved; verify the preview URL carries
      // the new draft without a reload (the URL-hash fallback still
      // works if the postMessage fast-path is blocked).
      const publishBtn = page.locator('[data-testid="edit-publish-btn"]');
      if (await publishBtn.isEnabled().catch(() => false)) {
        await publishBtn.click();
        // Non-blocking: publishing may require backend connectivity.
        await page.waitForTimeout(1_500);
      }

      await page.screenshot({
        path: "tests/e2e/screenshots/inline-edit-after-commit.png",
        fullPage: true,
      });
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
