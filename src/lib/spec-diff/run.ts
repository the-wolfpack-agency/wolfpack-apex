/**
 * Orchestrates a spec-diff run: load the prototype and the implementation at the
 * SAME viewports, measure both, and compare.
 *
 * Reuses the platform-scan browser abstraction rather than introducing a second
 * runner: the caller supplies a browser and (in production) platform-scan's
 * read-only network floor, so a comparison can never issue a mutating request at
 * either target. Everything else is injected, which keeps this file testable
 * with a fake page and no browser at all.
 *
 * Viewport HEIGHT is a first-class input, not an afterthought. A hero sized in
 * `vh` matches its prototype at one window height and looks obviously wrong at
 * another, and comparing two differently sized windows produces a bug report
 * about a difference that does not exist.
 */
import { compareItems, compareFonts, summarize, DEFAULT_TOLERANCE_PX, type SpecItem, type FontSample, type ViewportResult } from "./compare";
import { collectItems, collectFont } from "./probes";

export interface Viewport {
  width: number;
  height: number;
}

/** The slice of a Playwright page this needs. Structurally satisfied by the real
 *  thing, and by a fake in tests. */
export interface SpecDiffPage {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  setViewportSize?(size: Viewport): Promise<void>;
  close?(): Promise<void>;
}

export interface SpecDiffBrowser {
  newPage(): Promise<SpecDiffPage>;
}

export interface RunSpecDiffInput {
  /** The prototype: the source of truth. */
  specUrl: string;
  /** Our implementation. */
  targetUrl: string;
  viewports: Viewport[];
  tolerancePx?: number;
  /** Read-only network floor from platform-scan. Applied to every page. */
  installFloor?: (page: SpecDiffPage) => Promise<void>;
  /** Settle hook (fonts, mount effects) so measurements are not taken mid-render. */
  settle?: (page: SpecDiffPage) => Promise<void>;
  /** Authenticate before measuring our side (the prototype is always public). */
  authenticateTarget?: (page: SpecDiffPage) => Promise<void>;
  /** Surfaced instead of thrown, so one bad viewport cannot lose the whole run. */
  onError?: (info: { stage: string; viewport: Viewport; error: Error }) => void;
}

export interface SpecDiffRun {
  specUrl: string;
  targetUrl: string;
  tolerancePx: number;
  results: ViewportResult[];
  summary: ReturnType<typeof summarize>;
  errors: { stage: string; viewport: Viewport; message: string }[];
}

async function measure(
  browser: SpecDiffBrowser,
  url: string,
  viewport: Viewport,
  input: RunSpecDiffInput,
  authenticate?: (page: SpecDiffPage) => Promise<void>,
): Promise<{ items: SpecItem[]; font: FontSample | null }> {
  const page = await browser.newPage();
  try {
    if (input.installFloor) await input.installFloor(page);
    if (page.setViewportSize) await page.setViewportSize(viewport);
    if (authenticate) await authenticate(page);
    await page.goto(url);
    if (input.settle) await input.settle(page);
    const items = await page.evaluate(collectItems);
    const font = await page.evaluate(collectFont);
    return { items, font };
  } finally {
    if (page.close) await page.close();
  }
}

/**
 * Run the comparison across every viewport. A viewport that fails is recorded as
 * an error and skipped rather than aborting the run, because a partial report is
 * still actionable and a lost run is not.
 */
export async function runSpecDiff(input: RunSpecDiffInput, browser: SpecDiffBrowser): Promise<SpecDiffRun> {
  const tolerancePx = input.tolerancePx ?? DEFAULT_TOLERANCE_PX;
  const results: ViewportResult[] = [];
  const errors: { stage: string; viewport: Viewport; message: string }[] = [];

  for (const viewport of input.viewports) {
    try {
      const spec = await measure(browser, input.specUrl, viewport, input);
      const ours = await measure(browser, input.targetUrl, viewport, input, input.authenticateTarget);
      const { diffs, missing, matched } = compareItems(spec.items, ours.items, tolerancePx);
      results.push({ viewport, diffs, missing, matched, font: compareFonts(spec.font, ours.font) });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      input.onError?.({ stage: "measure", viewport, error });
      errors.push({ stage: "measure", viewport, message: error.message });
    }
  }

  return { specUrl: input.specUrl, targetUrl: input.targetUrl, tolerancePx, results, summary: summarize(results), errors };
}
