/**
 * Recording what a page contacted, once, for everything that needs it.
 *
 * observations.ts classifies traffic and detect.ts reasons about it: consent,
 * data sovereignty, unexplained signals. Both are pure, both are tested, and
 * both were fed from exactly one place, the single-page compliance collector.
 * The system walker, which visits dozens of screens of a client's system, threw
 * every request away.
 *
 * That is the more valuable capture of the two. "Which outside companies does
 * this system send data to, and from which screens" is the question a client
 * assessment exists to answer, and one page cannot answer it: a tracker on the
 * settings screen is invisible from the home page.
 *
 * ATTRIBUTED TO A SCREEN, WHICH IS THE WHOLE POINT. A recorder that returned
 * one flat list would say a system talks to six vendors. This says which
 * screens talk to which, so "the entries export contacts an analytics host"
 * is sayable and "somewhere in this product, something does" is not.
 *
 * BEST EFFORT ON THE BOUNDARY, and it says so rather than pretending. A
 * request in flight when the walk moves on is attributed to whichever screen
 * is current when the response arrives. Over a whole walk that misplaces a few
 * requests and loses none, which is the right trade for a map: a vendor
 * attributed to a neighbouring screen is a small error, and a vendor dropped
 * entirely is a wrong answer about where data goes.
 */

import type { ScanPage } from "../browser/capture";
import type { NetworkObservation } from "./observations";

export interface TrafficRecorder {
  /** Point subsequent responses at this screen. Call before navigating. */
  attributeTo(pageUrl: string): void;
  /** Everything recorded so far, across every screen. */
  observations(): NetworkObservation[];
  /** Drop what has been recorded, keeping the listener installed. */
  reset(): void;
}

export interface RecorderOptions {
  now?: () => number;
  /**
   * Cap on retained observations.
   *
   * A long walk of a busy application can produce tens of thousands of
   * requests, and the map is stored as one JSON document. The cap is generous
   * enough that no realiztic assessment reaches it and low enough that a
   * pathological page cannot exhaust memory. Reaching it is REPORTED by
   * truncated(), never silent, because a capped observation set that looked
   * complete would understate what a system contacts.
   */
  maxObservations?: number;
}

export const DEFAULT_MAX_OBSERVATIONS = 20_000;

/**
 * Install a response listener and collect what it sees.
 *
 * Reads through the ScanPage abstraction so this stays testable without a
 * browser, and uses the "response" event rather than a route interceptor so it
 * cannot conflict with the read-only floor, which owns the only route hook.
 */
export function createTrafficRecorder(
  page: ScanPage,
  opts: RecorderOptions = {},
): TrafficRecorder & { truncated: () => boolean } {
  const now = opts.now ?? Date.now;
  const max = opts.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const startedAt = now();

  let current = "";
  let truncated = false;
  let seen: NetworkObservation[] = [];

  page.on("response", (res: unknown) => {
    const r = res as {
      url?: () => string;
      status?: () => number;
      request?: () => { resourceType?: () => string };
    };
    try {
      const url = r.url?.() ?? "";
      if (!url) return;
      if (seen.length >= max) {
        truncated = true;
        return;
      }
      seen.push({
        url,
        pageUrl: current,
        resourceType: r.request?.()?.resourceType?.() ?? "other",
        atMs: Math.max(0, now() - startedAt),
        status: r.status?.() ?? null,
      });
    } catch {
      /* silent-ok: one unreadable response must not lose the rest of the
         capture, and there is nothing to report about it beyond its own
         absence from a set that is explicitly best-effort. */
    }
  });

  return {
    attributeTo: (pageUrl: string) => {
      current = pageUrl;
    },
    observations: () => [...seen],
    reset: () => {
      seen = [];
    },
    truncated: () => truncated,
  };
}
