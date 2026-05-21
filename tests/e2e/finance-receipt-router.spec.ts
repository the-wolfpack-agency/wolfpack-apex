/**
 * Finance → Receipt cross-page router — deployed-URL reality check.
 *
 * Verifies the unified intake surface on /finance/invoices:
 *   1. Signed-in user with finance.invoices.manage sees the
 *      Invoice / Receipt segmented toggle + the hero drop zone.
 *   2. Clicking the Receipt tab swaps the hero copy + drop zone
 *      testid.
 *   3. Dropping a receipt routes to /job-codes?pending_scan=<id> and
 *      the apply modal opens with rehydrated fields.
 *
 * The receipt-mode upload is intercepted with Playwright route mocks
 * so we don't burn a real Azure Form Recognizer transaction in CI.
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
const SPEC_NAME = "finance-receipt-router";

test.describe("finance — receipt cross-page router", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping finance receipt router check",
  );

  test("/finance/invoices renders the Invoice/Receipt toggle + hero drop zone", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";

    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn, "sign-in attempt must succeed").toBe(true);
      token = await authToken(page);
      expect(token, "auth token after sign-in").not.toEqual("");

      const navRes = await page.goto(`${target.baseUrl}/finance/invoices`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(navRes?.status() ?? 0, "/finance/invoices HTTP status").toBe(200);

      await expect(page.getByTestId("invoices-page")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("invoices-panel")).toBeVisible({ timeout: 10_000 });

      /* Manage-capability users see the router. Lower-privilege smoke
         users skip — they get the view-only hint instead. */
      const routerVisible = await page
        .getByTestId("scan-document-router")
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      if (!routerVisible) {
        result = "skip";
        return;
      }

      const invoiceTab = page.getByTestId("scan-mode-invoice");
      const receiptTab = page.getByTestId("scan-mode-receipt");
      await expect(invoiceTab).toBeVisible();
      await expect(receiptTab).toBeVisible();
      await expect(invoiceTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("invoice-upload-trigger")).toBeVisible();
      await expect(page.getByTestId("scan-drop-headline")).toContainText(/upload an invoice/i);

      await receiptTab.click();
      await expect(receiptTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("receipt-upload-trigger")).toBeVisible();
      await expect(page.getByTestId("scan-drop-headline")).toContainText(/upload a receipt/i);
      await expect(page.getByTestId("scan-drop-microcopy")).toContainText(/merchant/i);
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

  test("dropping a receipt on /finance/invoices lands on /job-codes with the apply modal open", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";

    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn).toBe(true);
      token = await authToken(page);

      const fakeScanId = `e2e-scan-${Date.now()}`;
      const fakeFields = {
        merchantName: "Synthetic Hardware",
        transactionDate: "2026-05-21",
        total: 42.5,
        subtotal: null,
        tax: null,
        currency: "USD",
        items: [],
        documentConfidence: 0.9,
        rawText: "",
      };

      /* Intercept the POST scan + GET rehydrate so the test never
         spends a real Azure transaction. The shapes mirror the prod
         handlers exactly. */
      await page.route("**/api/job-codes/scan-receipt", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, cached: false, scan_id: fakeScanId, fields: fakeFields }),
          });
        } else {
          await route.continue();
        }
      });
      await page.route(`**/api/job-codes/scan-receipt/${fakeScanId}`, async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              scan_id: fakeScanId,
              fields: fakeFields,
              original_filename: "e2e.png",
              uploaded_at: new Date().toISOString(),
              applied_to_code: null,
              applied_at: null,
            }),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto(`${target.baseUrl}/finance/invoices`, { waitUntil: "domcontentloaded", timeout: 30_000 });

      const routerVisible = await page
        .getByTestId("scan-document-router")
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      if (!routerVisible) {
        result = "skip";
        return;
      }

      await page.getByTestId("scan-mode-receipt").click();
      await expect(page.getByTestId("receipt-upload-trigger")).toBeVisible();

      const filePayload = {
        name: "e2e-receipt.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      };
      await page.getByTestId("receipt-upload-input").setInputFiles(filePayload);

      await page.waitForURL(/\/job-codes\?pending_scan=/, { timeout: 15_000 });
      expect(page.url()).toContain(`pending_scan=${fakeScanId}`);

      await expect(page.getByTestId("receipt-extracted-summary")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("receipt-extracted-summary")).toContainText("Synthetic Hardware");
    } catch (err) {
      result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: `${SPEC_NAME}-drop-and-land`,
        result,
        duration_ms: Date.now() - start,
      });
    }
  });
});
