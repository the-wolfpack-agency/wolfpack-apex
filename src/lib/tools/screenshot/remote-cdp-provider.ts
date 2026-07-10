/**
 * Remote-CDP screenshot engine (impl #2, the scale graduation path).
 *
 * Connects to a dedicated IN-HOUSE browser pool (a self-hosted browserless /
 * Playwright container) over CDP via BROWSER_WS_ENDPOINT. Warm browsers, no
 * cold start, scales independently of the app, and keeps rendering on Wolfpack
 * infra. Selected automatically when BROWSER_WS_ENDPOINT is set; no call-site
 * changes. Never a third party.
 */

import type { ScreenshotProvider, ScreenshotRequest, ScreenshotResult } from "./types";

export const remoteCdpProvider: ScreenshotProvider = {
  name: "remote-cdp",
  async capture(req: ScreenshotRequest): Promise<ScreenshotResult> {
    const endpoint = process.env.BROWSER_WS_ENDPOINT;
    if (!endpoint) {
      return { ok: false, code: "not_configured", error: "BROWSER_WS_ENDPOINT is not set" };
    }
    const width = req.viewportWidth ?? 1280;
    const height = req.viewportHeight ?? 800;
    const timeout = req.timeoutMs ?? 20_000;

    let browser: import("playwright-core").Browser | undefined;
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.connectOverCDP(endpoint, { timeout });
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(req.url, { waitUntil: "load", timeout });
      await page.waitForTimeout(500);
      const png = await page.screenshot({ fullPage: req.fullPage ?? true, type: "png" });
      await context.close();
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
