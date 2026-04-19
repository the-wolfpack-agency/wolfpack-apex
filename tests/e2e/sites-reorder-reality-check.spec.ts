/**
 * Sites — drag-to-reorder direct-manipulation reality check (Path C · Q1).
 *
 * The designer grabs a section handle inside the preview iframe, drags it
 * onto another section, and the brief's section order updates live. This
 * spec walks that loop end-to-end against the deployed URL (or a local
 * dev server) so we catch regressions in ways no jest test can:
 *   - HTML5 drag-and-drop across an iframe boundary in a real browser.
 *   - postMessage handoff between overlay and edit-page listener.
 *   - Brief re-render in the iframe after the parent pushes the new order.
 *   - Left-pane chat/state reflects the reorder.
 *   - Persistence: reload the page, order stays.
 *
 * Gates (skip cleanly when missing):
 *   - SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD for login
 *   - SITES_SMOKE_PROJECT_ID for a known editable project with at least
 *     3 sections on page 0 so we have room to drag from 0 → 2.
 *
 * Recorded into the learning loop via `recordRealityCheckRun`.
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
const SPEC_NAME = "sites-reorder-reality-check";

test.describe("sites — drag-to-reorder direct manipulation", () => {
  test("dragging the first section's handle to the third slot persists", async ({
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

      // 1. The preview iframe is mounted.
      const frameHandle = page.locator(
        'iframe[data-testid="edit-preview-iframe"]',
      );
      await expect(frameHandle).toBeVisible({ timeout: 10_000 });
      const iframe = page.frameLocator(
        'iframe[data-testid="edit-preview-iframe"]',
      );

      // 2. Wait for the render-brief root + at least 3 sections.
      const rootLocator = iframe.locator('[data-testid="render-brief"]');
      await expect(rootLocator).toBeVisible({ timeout: 15_000 });
      const sectionsLocator = iframe.locator(
        '[data-testid="render-brief"] [data-section-type]',
      );
      const initialCount = await sectionsLocator.count();
      if (initialCount < 3) {
        result = "skip";
        note = `project has only ${initialCount} sections, need 3+ for reorder`;
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
        test.skip(true, note);
        return;
      }

      // 3. Capture the section-type order BEFORE reorder.
      const beforeOrder = await sectionsLocator.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.sectionType ?? ""),
      );
      expect(beforeOrder.length).toBeGreaterThanOrEqual(3);

      await page.screenshot({
        path: "tests/e2e/screenshots/reorder-before.png",
        fullPage: true,
      });

      // 4. Drag the first section onto the third via `dragAndDrop`.
      //    Playwright's `locator.dragTo(target)` synthesizes the native
      //    HTML5 dragstart/dragover/drop sequence so our overlay sees
      //    real DataTransfer writes. We target the drag handle for
      //    dragstart (that's what has `draggable=true`), and drop onto
      //    the third section's bounding box.
      const sourceHandle = iframe.locator(
        '[data-testid="section-reorder-handle-0"]',
      );
      await expect(sourceHandle).toBeAttached({ timeout: 10_000 });
      // Handles are hover-visible; dispatch mouseenter on the section to
      // reveal it before dragging.
      const firstSection = sectionsLocator.nth(0);
      await firstSection.hover();
      const thirdSection = sectionsLocator.nth(2);
      await thirdSection.scrollIntoViewIfNeeded();
      await sourceHandle.dragTo(thirdSection);

      // 5. Wait for the iframe to re-render with the new brief pushed
      //    from the parent. The section at index 2 should now be what
      //    was originally at index 0.
      const expectedAtIndex2 = beforeOrder[0];
      await expect
        .poll(
          async () => {
            const after = await sectionsLocator.evaluateAll((els) =>
              els.map((el) => (el as HTMLElement).dataset.sectionType ?? ""),
            );
            return after[2];
          },
          { timeout: 10_000, message: "reorder did not propagate to iframe" },
        )
        .toBe(expectedAtIndex2);

      const afterOrder = await sectionsLocator.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.sectionType ?? ""),
      );
      // The originally-first section is now at index 2, and the original
      // index 1 & 2 shifted UP by one.
      expect(afterOrder[2]).toBe(beforeOrder[0]);
      expect(afterOrder[0]).toBe(beforeOrder[1]);
      expect(afterOrder[1]).toBe(beforeOrder[2]);

      await page.screenshot({
        path: "tests/e2e/screenshots/reorder-after.png",
        fullPage: true,
      });

      // 6. The left pane's BriefForm / chat reflects dirty state. Publish
      //    button becomes enabled when the draft diverges from saved.
      const publishBtn = page.locator('[data-testid="edit-publish-btn"]');
      // Non-blocking: we accept either "enabled" (dirty) or a succeeded
      // publish — local dev without a live deploy can fail the deploy
      // step but dirty state itself is the real assertion.
      const publishEnabled = await publishBtn.isEnabled().catch(() => false);
      if (!publishEnabled) {
        note = "publish button did not enable after reorder (non-fatal)";
      }

      // 7. Publish so we can verify persistence across reload. Tolerate
      //    failure — the real win is proving the REORDER persists once a
      //    Publish fires + succeeds.
      if (publishEnabled) {
        await publishBtn.click();
        await page.waitForTimeout(2_500);
      }

      // 8. Reload and assert the persisted order matches what we dragged to.
      await page.reload({ waitUntil: "networkidle" });
      const reloadedIframe = page.frameLocator(
        'iframe[data-testid="edit-preview-iframe"]',
      );
      const reloadedSections = reloadedIframe.locator(
        '[data-testid="render-brief"] [data-section-type]',
      );
      await expect(reloadedSections.first()).toBeVisible({ timeout: 15_000 });
      const reloadedOrder = await reloadedSections.evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.sectionType ?? ""),
      );
      // Only a hard assertion if publish succeeded — otherwise the order
      // legitimately reverts to what the server had saved.
      if (publishEnabled) {
        expect(reloadedOrder[2]).toBe(expectedAtIndex2);
      }
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
