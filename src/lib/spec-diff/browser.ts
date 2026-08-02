/**
 * Browser factory for spec-diff.
 *
 * Playwright is a heavy, optional dependency at runtime: the comparison needs a
 * real engine (computed styles and layout cannot be faked), but the rest of the
 * app must not fail to build or boot because of it. So it is imported lazily and
 * the caller gets a clear `browser_unavailable` instead of a crash.
 *
 * The read-only floor comes from platform-scan, deliberately reused: a
 * comparison must never be able to issue a mutating request at either target.
 */
import { installReadOnlyFloor, type ScanPage } from "@/lib/platform-scan/browser/capture";
import type { SpecDiffBrowser, SpecDiffPage } from "./run";

export interface SpecDiffBrowserHandle {
  browser: SpecDiffBrowser;
  hooks: {
    installFloor: (page: SpecDiffPage) => Promise<void>;
    settle: (page: SpecDiffPage) => Promise<void>;
  };
  close: () => Promise<void>;
}

/** How long to let fonts and mount effects settle before measuring. */
const SETTLE_MS = 1500;

/**
 * Where the browser comes from.
 *
 * `chromium.launch()` needs a chromium BINARY on the machine, and a Vercel
 * function does not have one. Every production run of the acceptance gate
 * therefore degraded, on a ten-minute cron, since the day it shipped — cleanly
 * and silently, which is the worst combination: a gate that reports a tidy
 * "unavailable" forever looks healthier than one that crashes, and nobody
 * investigates a control that never complains.
 *
 * Found by the route-runtime-capability guardrail, not by anyone noticing.
 *
 * The fix reuses the engine selection the screenshot tool already ships: when
 * BROWSER_WS_ENDPOINT names an in-house browser pool, connect to it over CDP.
 * Same variable, same infrastructure, no new dependency and no second pattern
 * to keep in step. Without it the local launch is still used, which is correct
 * for CI and a developer machine and honest everywhere else.
 */
export type SpecDiffBrowserSource = "remote-cdp" | "local-launch";

export function specDiffBrowserSource(): SpecDiffBrowserSource {
  return process.env.BROWSER_WS_ENDPOINT ? "remote-cdp" : "local-launch";
}

/** Thrown when no browser could be obtained. Typed so a caller can report "we
 *  never measured" as its own outcome instead of folding it in with "the
 *  measurement failed" — they call for completely different actions. */
export class BrowserUnavailableError extends Error {
  readonly source: SpecDiffBrowserSource;
  constructor(source: SpecDiffBrowserSource, cause: unknown) {
    super(`no browser available (${source}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BrowserUnavailableError";
    this.source = source;
  }
}

export async function createSpecDiffBrowser(): Promise<SpecDiffBrowserHandle> {
  const source = specDiffBrowserSource();
  const endpoint = process.env.BROWSER_WS_ENDPOINT;

  let browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>>;
  try {
    const { chromium } = (await import("playwright")) as typeof import("playwright");
    browser =
      source === "remote-cdp" && endpoint
        ? await chromium.connectOverCDP(endpoint, { timeout: 20_000 })
        : await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (err) {
    throw new BrowserUnavailableError(source, err);
  }
  const context = await browser.newContext();

  return {
    browser: {
      newPage: async () => (await context.newPage()) as unknown as SpecDiffPage,
    },
    hooks: {
      installFloor: async (page) => {
        await installReadOnlyFloor(page as unknown as ScanPage);
      },
      settle: async (page) => {
        const p = page as unknown as {
          waitForLoadState?: (state: string) => Promise<void>;
          evaluate: (fn: () => unknown) => Promise<unknown>;
          waitForTimeout?: (ms: number) => Promise<void>;
        };
        await p.waitForLoadState?.("networkidle").catch(() => {});
        // Webfonts change every measurement, so never measure before they land.
        await p.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => {});
        await p.waitForTimeout?.(SETTLE_MS);
      },
    },
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
