/**
 * Serverless-Chromium screenshot engine (impl #1, ships now).
 *
 * On Vercel/Lambda (Linux) it drives @sparticuz/chromium via playwright-core.
 * Locally (mac/dev) it falls back to the system Chrome channel so the same code
 * path works in dev. Everything runs on Wolfpack infra — a client page never
 * leaves it. For scale, swap in the remote-CDP engine (impl #2) via
 * BROWSER_WS_ENDPOINT; call sites do not change.
 *
 * The heavy browser imports are dynamic so this module (and its unit tests)
 * loads without pulling Chromium into every bundle.
 */

import type { ScreenshotProvider, ScreenshotRequest, ScreenshotResult } from "./types";

function isServerlessLinux(): boolean {
  return (
    process.platform === "linux" &&
    Boolean(
      process.env.VERCEL ||
        process.env.AWS_REGION ||
        process.env.AWS_LAMBDA_FUNCTION_NAME,
    )
  );
}

export const serverlessChromiumProvider: ScreenshotProvider = {
  name: "serverless-chromium",
  async capture(req: ScreenshotRequest): Promise<ScreenshotResult> {
    const width = req.viewportWidth ?? 1280;
    const height = req.viewportHeight ?? 800;
    const timeout = req.timeoutMs ?? 20_000;

    let browser: import("playwright-core").Browser | undefined;
    try {
      const { chromium } = await import("playwright-core");

      let launchOptions: Parameters<typeof chromium.launch>[0];
      if (isServerlessLinux()) {
        // Lambda/Vercel: use the bundled headless-shell binary.
        const sparticuz = (await import("@sparticuz/chromium")).default;
        launchOptions = {
          args: sparticuz.args,
          executablePath: await sparticuz.executablePath(),
          headless: true,
        };
      } else {
        // Local/dev: drive the developer's installed Chrome.
        launchOptions = { channel: "chrome", headless: true };
      }

      browser = await chromium.launch(launchOptions);
      const page = await browser.newPage({ viewport: { width, height } });
      // "load" is reliable across chatty pages; a short settle lets late paint
      // finish without the flakiness of waiting for full network idle.
      await page.goto(req.url, { waitUntil: "load", timeout });
      await page.waitForTimeout(500);
      const png = await page.screenshot({
        fullPage: req.fullPage ?? true,
        type: "png",
      });
      return { ok: true, png: Buffer.from(png) };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const code = /timeout/i.test(msg) ? "timeout" : "capture_failed";
      return { ok: false, code, error: msg };
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  },
};
