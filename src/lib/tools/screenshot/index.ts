/**
 * Screenshot capture — public entry.
 *
 * `captureScreenshot` SSRF-guards the URL (reusing the platform-scan guard, so
 * an agent can never be steered into screenshotting an internal service), then
 * delegates to the selected engine. Engine selection: a dedicated in-house
 * browser pool when BROWSER_WS_ENDPOINT is set (scale), else serverless
 * Chromium in-app (launch). Both keep rendering on Wolfpack infra.
 */

import { assertScannableUrl, SsrfBlockedError } from "@/lib/platform-scan/ssrf-guard";
import type { ScreenshotProvider, ScreenshotRequest, ScreenshotResult } from "./types";
import { serverlessChromiumProvider } from "./serverless-chromium-provider";
import { remoteCdpProvider } from "./remote-cdp-provider";

export type {
  ScreenshotProvider,
  ScreenshotRequest,
  ScreenshotResult,
  ScreenshotFailureCode,
} from "./types";

/** Pick the engine: dedicated in-house pool if configured, else serverless. */
export function getScreenshotProvider(): ScreenshotProvider {
  return process.env.BROWSER_WS_ENDPOINT ? remoteCdpProvider : serverlessChromiumProvider;
}

/**
 * SSRF-guard the URL, then capture. `provider` is injectable so callers and
 * tests can supply a fake engine without launching a browser.
 */
export async function captureScreenshot(
  req: ScreenshotRequest,
  provider: ScreenshotProvider = getScreenshotProvider(),
): Promise<ScreenshotResult> {
  try {
    await assertScannableUrl(req.url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return { ok: false, code: "ssrf_blocked", error: err.message };
    }
    return { ok: false, code: "capture_failed", error: (err as Error).message };
  }
  return provider.capture(req);
}
