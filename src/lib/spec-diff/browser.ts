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

export async function createSpecDiffBrowser(): Promise<SpecDiffBrowserHandle> {
  const { chromium } = (await import("playwright")) as typeof import("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
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
