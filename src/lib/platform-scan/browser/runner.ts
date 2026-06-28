/**
 * Tier-1 browser UX scan RUNNER (pure orchestration).
 *
 * Drives the read-only capture core (capture.ts) over a list of routes and hands
 * the resulting RAW observations to an injected `ingest` sink. Like capture.ts it
 * imports NO Playwright and NO fetch: the browser factory and the ingest sink are
 * both injected, so the whole control flow is unit-testable with mocks and no real
 * browser or network is ever required. The live CLI (scripts/ux-scan.mjs) supplies
 * a real chromium-backed browser and an ingest sink that POSTs to apex.
 *
 * Resilience: one route that throws (navigation crash, evaluate failure that even
 * capturePage could not swallow, page-creation failure) must NOT abort the whole
 * scan. We isolate each route; a failed page yields no observation and the scan
 * continues, so partial coverage is still ingested rather than lost entirely.
 */

import type { PageObservation, AxeViolation } from "./classify";
import {
  capturePage,
  installReadOnlyFloor,
  type ScanPage,
} from "./capture";

/** Minimal browser factory: only the one method the runner needs. The live CLI's
 *  real Playwright browser context satisfies this structurally. */
export interface ScanBrowser {
  newPage(): Promise<ScanPage>;
}

export interface RunUxScanInput {
  baseUrl: string;
  routes: { path: string; journey: string }[];
  /** Sink for the raw observations (e.g. POST to the ingest endpoint). Injected so
   *  the runner never touches the network directly. Called once with ALL
   *  observations gathered this run. */
  ingest: (observations: PageObservation[]) => Promise<void>;
  /** Injectable clock, threaded into capturePage for deterministic durationMs. */
  now?: () => number;
  /** Optional accessibility runner (axe-core), threaded into capturePage so each
   *  observation carries axe violations the server classifies. The live CLI
   *  supplies it; tests/unit runs omit it. Keeps capture.ts axe-free. */
  runAxe?: (page: ScanPage) => Promise<AxeViolation[]>;
  /** Best-effort sink for per-route failures, so a crashed page is observable in
   *  the learning loop instead of silently dropped. Optional. */
  onRouteError?: (info: { path: string; journey: string; error: Error }) => void;
}

/**
 * Run the read-only UX scan. For each route: open a fresh page, install the
 * read-only network floor (so no mutating request can ever leave), capture the
 * raw observation, and collect it. After all routes, call ingest ONCE with the
 * full set (zero observations is a valid, healthy run still worth recording).
 *
 * The route URL passed to capturePage is the absolute URL (baseUrl + path) so the
 * caller does not need a relative-base configured on the page.
 */
export async function runUxScan(
  input: RunUxScanInput,
  browser: ScanBrowser,
): Promise<{ observations: PageObservation[] }> {
  const observations: PageObservation[] = [];
  const base = input.baseUrl.replace(/\/$/, "");

  for (const route of input.routes) {
    try {
      const page: ScanPage = await browser.newPage();
      await installReadOnlyFloor(page);
      const url = new URL(route.path, base + "/").toString();
      const obs = await capturePage(
        page,
        { route: url, journey: route.journey },
        { now: input.now, runAxe: input.runAxe },
      );
      // Preserve the human-facing path on the observation's route so findings are
      // attributed to the route the operator configured, not the resolved URL.
      observations.push({ ...obs, route: route.path });
    } catch (err) {
      // Isolate the failure: this route is lost but the scan continues.
      input.onRouteError?.({
        path: route.path,
        journey: route.journey,
        error: err as Error,
      });
    }
  }

  await input.ingest(observations);
  return { observations };
}
