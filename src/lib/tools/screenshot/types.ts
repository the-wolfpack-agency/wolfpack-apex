/**
 * Screenshot capture — provider-agnostic types.
 *
 * The capture engine is abstracted behind ScreenshotProvider (the same
 * provider-registry pattern the AI router and crypto registry use), so the
 * browser can graduate from in-app serverless Chromium to a dedicated in-house
 * browser pool (connect over CDP) with zero call-site changes. Rendering always
 * stays on Wolfpack infra: a client page is never sent to a third party.
 */

export interface ScreenshotRequest {
  /** Absolute http(s) URL. SSRF-guarded before any provider runs. */
  url: string;
  /** Full-page vs viewport. Default true. */
  fullPage?: boolean;
  viewportWidth?: number; // default 1280
  viewportHeight?: number; // default 800
  /** Navigation timeout in ms. Default 20000. */
  timeoutMs?: number;
}

export type ScreenshotFailureCode =
  | "ssrf_blocked" // the URL failed the SSRF guard
  | "not_configured" // the selected engine has no endpoint/binary
  | "timeout"
  | "capture_failed";

export type ScreenshotResult =
  | { ok: true; png: Buffer }
  | { ok: false; code: ScreenshotFailureCode; error: string };

export interface ScreenshotProvider {
  /** Stable engine name, recorded in analytics (e.g. "serverless-chromium"). */
  readonly name: string;
  capture(req: ScreenshotRequest): Promise<ScreenshotResult>;
}
