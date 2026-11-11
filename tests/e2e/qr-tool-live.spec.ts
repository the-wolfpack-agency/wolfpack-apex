/**
 * QR tool, live, end to end against the deployed app.
 *
 * Signed in as the smoke account, this walks the whole life of one code:
 *   1. /qr answers 200, renders, and logs no CSP violation or console error.
 *   2. The create form mints a code; the created panel shows its slug and SVG.
 *   3. /q/<slug> (redirects NOT followed) answers 302 to the target URL.
 *   4. The scan is recorded: the row's scan count reads at least 1 after a
 *      reload. recordScan is fire-and-forget in the route, so this polls.
 *      Bots are counted too (total_scans is COUNT(*); is_bot is only a flag),
 *      so the automated scan below is a real scan for this purpose.
 *   5. The page's own download control saves a non-empty SVG and PNG.
 *   6. The code is archived in `finally`, whatever failed before it.
 *
 * The target is a harmless https://example.com URL carrying a unique marker,
 * and the label is unique per run, so concurrent or retried runs never touch
 * each other's codes.
 *
 * Bot protection: the project in playwright.config.ts uses
 * devices["Desktop Chrome"], whose user agent is a regular Chrome string, not
 * HeadlessChrome. Every deployed spec in this suite runs the same way; this
 * spec adds no override and nothing that weakens the protection.
 *
 * Skips, with the reason, only when PROD_URL or the smoke credentials are
 * missing. The workflow step that runs it warns separately when the
 * credentials are absent, because a skipped Playwright test reports as a pass.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  hasInstinctToken,
  authToken,
  collectConsoleAndNetworkFailures,
  expectRendered,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("QR tool, live", () => {
  test.skip(!target.isProduction, "PROD_URL is not set: this spec targets the deployed app only.");
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL / SMOKE_TEST_PASSWORD are not set: the QR tool needs a signed-in session.",
  );

  test("create, scan, count, download, archive", async ({ page }) => {
    test.setTimeout(150_000);
    const stamp = Date.now();
    const label = `e2e-qr-${stamp}`;
    const targetUrl = `https://example.com/?e2e=${stamp}`;

    // Console errors, collected alongside the shared CSP / pageerror / network
    // collector so a noisy page fails here, not only at the UI layer later.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const failures = collectConsoleAndNetworkFailures(page);

    expect(await signInIfPossible(page, target), "login form never became ready").toBe(true);
    expect(await hasInstinctToken(page), "sign-in did not produce a session token").toBe(true);

    let createdId: string | null = null;
    let token = "";
    try {
      // 1. Open /qr.
      const res = await page.goto(`${target.baseUrl}/qr`, { waitUntil: "domcontentloaded" });
      expect(res?.status(), "GET /qr status").toBe(200);
      await expect(page.getByTestId("qr-page")).toBeVisible();
      await expectRendered(page, "/qr", ["your qr codes"]);
      token = await authToken(page);

      // 2. Create a code through the form.
      await page.getByTestId("qr-create-label").fill(label);
      await page.getByTestId("qr-create-target-url").fill(targetUrl);
      const createResp = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/qr" && r.request().method() === "POST",
      );
      await page.getByTestId("qr-create-submit").click();
      const created = await createResp;
      expect(created.status(), "POST /api/qr status").toBe(200);
      const body = (await created.json()) as { code: { id: string; slug: string } };
      createdId = body.code.id;
      const slug = body.code.slug;
      expect(slug, "created slug").toMatch(/^[A-Za-z0-9_-]+$/);

      const panel = page.getByTestId("qr-latest-created");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(slug);
      const svg = page.getByTestId("qr-latest-svg").locator("svg");
      await expect(svg).toBeVisible();
      expect(await svg.locator("rect, path").count(), "QR SVG has drawn modules").toBeGreaterThan(0);

      // Snapshot the page state now: /qr after create must be clean.
      await page.waitForTimeout(2_000);
      expect(failures(), "CSP / network failures on /qr").toEqual([]);
      expect(consoleErrors, "console errors on /qr").toEqual([]);

      // 5. Download SVG and PNG through the page's own control.
      for (const format of ["svg", "png"] as const) {
        await page.getByTestId("qr-latest-download-format").selectOption(format);
        const dl = page.waitForEvent("download");
        await page.getByTestId("qr-latest-download-go").click();
        const download = await dl;
        expect(download.suggestedFilename(), `${format} filename`).toBe(`qr-${slug}.${format}`);
        const path = await download.path();
        expect(path, `${format} download saved`).toBeTruthy();
        const bytes = (await import("node:fs")).readFileSync(path as string);
        expect(bytes.length, `${format} download is non-empty`).toBeGreaterThan(0);
        if (format === "svg") {
          expect(bytes.toString("utf8"), "SVG download is SVG markup").toMatch(/<svg[\s>]/);
        } else {
          expect(
            bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
            "PNG download has the PNG signature",
          ).toBe(true);
        }
      }

      // 3. Scan it: the public redirect, not followed.
      const scan = await page.request.get(`${target.baseUrl}/q/${slug}`, { maxRedirects: 0 });
      expect(scan.status(), "GET /q/<slug> status").toBe(302);
      const location = scan.headers()["location"] ?? "";
      const dest = new URL(location, target.baseUrl);
      expect(dest.origin, "redirect goes to the target origin").toBe("https://example.com");
      expect(dest.searchParams.get("e2e"), "redirect keeps the target query").toBe(String(stamp));

      // 4. The scan is recorded. Wait for the API, then prove it in the UI.
      await expect
        .poll(
          async () => {
            const r = await page.request.get(`${target.baseUrl}/api/qr/${createdId}/analytics`, {
              headers: { authorization: `Bearer ${await authToken(page)}` },
            });
            if (!r.ok()) return -1;
            return ((await r.json()) as { total_scans?: number }).total_scans ?? 0;
          },
          { message: "scan recorded in analytics", timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
        )
        .toBeGreaterThanOrEqual(1);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId(`qr-row-${slug}`)).toBeVisible();
      await page.getByTestId(`qr-row-analytics-${slug}`).click();
      const count = page.getByTestId(`qr-row-scancount-${slug}`);
      await expect(count).toHaveText(/^[1-9]\d* scans?$/);
    } finally {
      // 6. Clean up, whatever happened above.
      if (createdId) {
        await archive(page, createdId, token);
      }
    }
  });
});

/** Archive with the page's own credential: the current token when the page is
 *  still usable, else the one captured earlier. Never throws: a failed cleanup
 *  is reported as an annotation, not as a second failure masking the first. */
async function archive(page: Page, id: string, fallbackToken: string): Promise<void> {
  try {
    const current = await authToken(page).catch(() => "");
    const res = await page.request.delete(`${resolveSmokeTarget().baseUrl}/api/qr/${id}`, {
      headers: { authorization: `Bearer ${current || fallbackToken}` },
    });
    if (!res.ok()) {
      test.info().annotations.push({ type: "cleanup", description: `archive of ${id} answered ${res.status()}` });
    }
  } catch (err) {
    test.info().annotations.push({ type: "cleanup", description: `archive of ${id} threw: ${(err as Error).message}` });
  }
}
