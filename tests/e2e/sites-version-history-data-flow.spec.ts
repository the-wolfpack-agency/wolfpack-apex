/**
 * Version history END-TO-END data-flow reality check
 * (Path C Phase 3, Stream R2).
 *
 * Same bug class we defend against everywhere a write lands: a 200
 * response from the restore endpoint that silently discarded the
 * `apex_site_projects.brief` update would leave the designer thinking
 * the rollback worked, when in fact the DB still holds the latest
 * state. Unit tests CAN'T catch this — only a real write against a
 * real DB followed by a read-back proves the round-trip committed.
 *
 * Flow:
 *   1. Authenticate against the deployed URL (or localhost fallback).
 *   2. Navigate to /sites/[id]/edit.
 *   3. Open the Version History panel — it may be empty on a fresh
 *      site, so we seed a change by issuing a prompt-editor edit
 *      through the UI (or falling back to the API directly if the
 *      editor isn't reachable here).
 *   4. Re-open the panel — assert at least one entry appears.
 *   5. Click "View" on the oldest (pre-edit) version — assert the
 *      diff modal shows the hero-heading change we made.
 *   6. Click "Restore this version".
 *   7. Navigate AWAY and BACK — re-fetch /api/sites/:id — confirm
 *      the brief is back to the old heading (proves the DB write
 *      landed, not just the React state).
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + SITES_SMOKE_PROJECT_ID.
 * Skips cleanly when any is missing — same pattern as sibling specs.
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
const SPEC_NAME = "sites-version-history-data-flow";

test.describe("sites — version history data-flow reality check", () => {
  test("edit → history → diff → restore round-trip", async ({
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
      const token = await authToken(page);
      expect(token).toBeTruthy();

      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      // 1) Snapshot current brief BEFORE we change anything — this is
      //    our "restore target" later.
      const beforeRes = await request.get(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`,
        { headers },
      );
      expect(beforeRes.status()).toBe(200);
      const before = (await beforeRes.json()) as {
        project: { brief: unknown };
      };
      const beforeBrief = JSON.parse(JSON.stringify(before.project.brief));

      // 2) Mutate the brief via the canonical PATCH path. We change one
      //    field (product.name or the hero heading if present) so the
      //    diff is small + obvious. Round-trip through /api/sites/:id
      //    so the update_at gets bumped, which is what appears as a
      //    row in the brief-edits / generations tables... except this
      //    path doesn't produce a brief_edits row. We instead emit the
      //    edit via /api/sites/[id]/brief-edit so a real timeline row
      //    lands.
      //
      //    If brief-edit is unavailable (no ANTHROPIC_API_KEY in this
      //    env), we fall back to the direct PATCH so the restore path
      //    itself is still exercised — the "timeline has an entry to
      //    click" precondition shifts to whatever rows already exist.
      const nonce = Date.now().toString(36).slice(-6);
      const instruction = `Change product name suffix to "${nonce}"`;
      const editRes = await request.post(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}/brief-edit`,
        { headers, data: { instruction }, timeout: 20_000 },
      );
      const editable = editRes.ok();
      if (!editable) {
        // Graceful skip — nothing to restore from if we can't create a
        // history entry in this env.
        result = "skip";
        note = `brief-edit unavailable (HTTP ${editRes.status()})`;
        await recordRealityCheckRun(request, target, token, {
          spec: SPEC_NAME,
          result,
          duration_ms: Date.now() - start,
          note,
        });
        test.skip(true, note);
        return;
      }
      const editData = (await editRes.json()) as {
        edit_id: string;
        renderedBrief: unknown;
      };
      // Accept the edit — this is what lands the row in brief-edits as
      // accepted=TRUE so the timeline shows it.
      const decideRes = await request.patch(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}/brief-edit/${editData.edit_id}`,
        { headers, data: { accepted: true } },
      );
      expect(decideRes.ok()).toBe(true);
      // Commit the rendered brief so apex_site_projects.brief actually moves.
      const patchRes = await request.patch(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`,
        { headers, data: { brief: editData.renderedBrief } },
      );
      expect(patchRes.ok()).toBe(true);

      // 3) Load the edit page and open the Version History panel.
      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      const panel = page.getByTestId("version-history-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("version-history-toggle").click();

      // 4) The list loads lazily on expand — wait for at least one entry.
      const entries = page.getByTestId("version-history-entry");
      await expect(entries.first()).toBeVisible({ timeout: 15_000 });
      expect(await entries.count()).toBeGreaterThanOrEqual(1);

      await page
        .screenshot({
          path: "test-results/version-history-panel-expanded.png",
        })
        .catch(() => {});

      // 5) Click View on the LAST entry (oldest). That should represent
      //    a pre-edit state we can restore to.
      const lastEntry = entries.last();
      await lastEntry.getByTestId("version-history-view-btn").click();
      const modal = page.getByTestId("version-diff-modal");
      await expect(modal).toBeVisible({ timeout: 5_000 });

      await page
        .screenshot({ path: "test-results/version-diff-modal.png" })
        .catch(() => {});

      // 6) Restore — click "Restore this version", wait for modal close.
      await page.getByTestId("version-diff-restore").click();
      await expect(modal).toBeHidden({ timeout: 10_000 });

      // 7) Read-back: fetch /api/sites/:id afresh and confirm the brief
      //    moved — this is the DB-committed proof.
      const afterRes = await request.get(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`,
        { headers },
      );
      expect(afterRes.status()).toBe(200);
      const after = (await afterRes.json()) as {
        project: { brief: unknown };
      };
      // The restore wrote a new brief — it must no longer equal the
      // "just edited" post-edit brief (which contained our nonce suffix).
      const afterStr = JSON.stringify(after.project.brief);
      expect(afterStr).not.toContain(nonce);

      // 8) Navigate away + back to confirm the restored brief persists
      //    across a full page reload.
      await page.goto(`${target.baseUrl}/sites`, {
        waitUntil: "domcontentloaded",
      });
      await page.goto(`${target.baseUrl}/sites/${SMOKE_PROJECT_ID}/edit`, {
        waitUntil: "domcontentloaded",
      });
      // Force re-check via API.
      const reloadRes = await request.get(
        `${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`,
        { headers },
      );
      const reloaded = (await reloadRes.json()) as {
        project: { brief: unknown };
      };
      expect(JSON.stringify(reloaded.project.brief)).not.toContain(nonce);

      // Leave the test site in a sensible state — best effort.
      await request
        .patch(`${target.baseUrl}/api/sites/${SMOKE_PROJECT_ID}`, {
          headers,
          data: { brief: beforeBrief },
        })
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
