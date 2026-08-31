/**
 * /documents/recognize — full-journey reality check.
 *
 * Walks the deployed (or local) URL through the recognition flow:
 *   1. Authenticate (real creds when SMOKE_TEST_EMAIL/PASSWORD are
 *      set, otherwise a stubbed session that keeps the layout's
 *      auth-refresh chain happy).
 *   2. Visit /documents/recognize and assert HTTP 200, drop zone
 *      visible. 200, not "not 500" — 401s blank pages too (per
 *      CLAUDE.md / feedback_test_200_not_500.md).
 *   3. Upload a tiny synthetic PNG fixture (built on the fly via the
 *      shared `ensureFixture` helper — zero new deps).
 *   4. The recognize API is mocked at the network layer so we never
 *      burn a real classifier or Azure transaction in CI.
 *   5. Spinner clears, ClassificationCard renders with a type label,
 *      ExtractedFieldsTable renders rows (or the explicit empty
 *      state).
 *   6. Reclassify via the dropdown — assert optimiztic update of the
 *      visible type label.
 *   7. "Scan another" returns the user to the drop zone.
 *   8. Throughout, a console + network failure listener guarantees
 *      no CSP violations and no unexpected 4xx/5xx XHRs.
 *
 * The spec is intentionally tolerant about WHICH classification the
 * mocked API returns — what we're verifying is the UI journey, not
 * the classifier itself. Stream A's contract tests pin the classifier.
 *
 * Spec file path: this repo's playwright.config.ts points testDir at
 * `./tests/e2e`. Putting the file directly under `e2e/` would mean it
 * never runs, so it lives here alongside the other E2E specs.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";
import { ensureFixture } from "./fixtures/generate-fixtures";

const target = resolveSmokeTarget();
const SPEC_NAME = "documents-recognize";

/* Shared mock response — the UI doesn't care about the exact values,
   just that the shape matches RecognizedDocument. */
const MOCK_RECOGNIZED = {
  id: "rec_e2e_1",
  workspaceId: "ws_e2e",
  userId: "u_e2e",
  sourceFile: {
    filename: "sample-receipt.png",
    mime: "image/png",
    bytes: 1024,
    sha256: "e2e-sha",
  },
  classification: {
    type: "receipt",
    confidence: 0.92,
    alternates: [{ type: "invoice", confidence: 0.05 }],
    rationale: "Header reads 'RECEIPT' with a clear total line.",
    model: "claude-3-haiku",
    latencyMs: 312,
    costCents: 0.1,
  },
  extraction: {
    extractor: "azure_prebuilt_receipt",
    model: "prebuilt-receipt",
    fields: [
      { name: "vendor", value: "Synthetic Hardware", confidence: 0.95 },
      { name: "total", value: "42.50", confidence: 0.9 },
      { name: "transaction_date", value: "2026-05-21", confidence: 0.85 },
    ],
    rawText: "RECEIPT Synthetic Hardware 42.50",
    latencyMs: 540,
    costCents: 0,
  },
  piiBlocked: false,
  recognizedAt: new Date().toISOString(),
};

test.describe("/documents/recognize — full journey", () => {
  test("upload, classify, reclassify, scan another", async ({ page, request }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";

    /* Install console + network failure collector BEFORE any
       navigation so we catch CSP violations the moment the document
       loads. */
    const snapshot = collectConsoleAndNetworkFailures(page);

    try {
      /* Auth setup — try real creds, fall back to a stubbed session
         so the spec can also run against PR previews that don't have
         a real user provisioned. */
      const signedIn = await signInIfPossible(page, target);
      if (!signedIn) {
        await stubInstinctSession(page, {
          id: "u-e2e",
          email: "e2e@instinct.local",
          name: "E2E",
          role: "ops",
        });
      }

      /* Intercept the recognize API so we never burn a real vendor
         call. POST returns the mock, PATCH echoes ok. */
      await page.route("**/api/documents/recognize", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MOCK_RECOGNIZED),
          });
        } else {
          await route.continue();
        }
      });
      await page.route(
        `**/api/documents/recognize/${MOCK_RECOGNIZED.id}`,
        async (route) => {
          if (route.request().method() === "PATCH") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ok: true }),
            });
          } else {
            await route.continue();
          }
        },
      );

      /* HTTP 200 — explicit (not "not 500") per CLAUDE.md. 401 would
         blank the page just as effectively as 500. */
      const navRes = await page.goto(
        `${target.baseUrl}/documents/recognize`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      expect(
        navRes?.status() ?? 0,
        "/documents/recognize HTTP status",
      ).toBe(200);

      await expect(page.getByTestId("documents-recognize-page")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("recognize-drop-zone")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("recognize-drop-headline")).toContainText(
        /upload a document/i,
      );

      token = await authToken(page);

      /* Upload the synthetic PNG fixture. The helper writes the file
         on demand (idempotent) — zero new deps. */
      const fixturePath = ensureFixture("sample-receipt.png", "RECEIPT");
      await page
        .getByTestId("recognize-upload-input")
        .setInputFiles(fixturePath);

      /* Wait for the classification card — the spinner is between the
         drop and this assertion. */
      await expect(page.getByTestId("classification-card")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("classification-type-label"),
      ).toContainText(/receipt/i);

      /* Either a populated table OR the explicit empty state must
         render — never a silent blank. */
      const tableVisible = await page
        .getByTestId("extracted-fields-table")
        .isVisible()
        .catch(() => false);
      const emptyVisible = await page
        .getByTestId("extracted-fields-empty")
        .isVisible()
        .catch(() => false);
      expect(
        tableVisible || emptyVisible,
        "extracted fields table OR explicit empty state must render",
      ).toBe(true);

      if (tableVisible) {
        /* At least one row when the table is rendered (the mock has
           three fields). */
        const rowCount = await page
          .locator('[data-testid^="extracted-field-row-"]')
          .count();
        expect(rowCount).toBeGreaterThan(0);
      }

      /* Reclassify — pick a different document type, then assert the
         optimiztic update flipped the visible label. */
      await page
        .getByTestId("classification-reclassify-select")
        .selectOption("invoice");
      await expect(
        page.getByTestId("classification-type-label"),
      ).toContainText(/invoice/i);
      await expect(
        page.getByTestId("classification-corrected-indicator"),
      ).toBeVisible();

      /* "Scan another" returns to the drop zone. */
      await page.getByTestId("recognize-scan-another").click();
      await expect(page.getByTestId("recognize-drop-zone")).toBeVisible();
      await expect(
        page.getByTestId("classification-card"),
      ).not.toBeVisible();

      /* Allow a short idle window for any async CSP/network errors to
         surface, then assert clean. */
      await page.waitForTimeout(2_000);
      const failures = snapshot();
      expect(
        failures,
        `CSP/network failures during /documents/recognize:\n${failures
          .map((f) => `  - [${f.kind}] ${f.detail}`)
          .join("\n")}`,
      ).toEqual([]);
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
});
