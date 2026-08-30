/**
 * The thing that actually walks a system.
 *
 * WHAT WAS MISSING. Every rule for mapping existed and nothing ran them.
 * explore.ts holds the frontier, the follow rules and the budget; click-policy
 * holds what may be clicked; types.ts describes the map. All of it was
 * referenced only by its own tests. The capability was a set of parts.
 *
 * This is the driver: it walks, and it asks the existing rules every question
 * rather than deciding anything itself. Where to go next is explore.ts. What
 * is safe to click is click-policy.ts. When to stop is the budget. Keeping the
 * judgement out of the driver is what lets all of it stay testable without a
 * browser, and this file testable without a client system.
 *
 * READ-ONLY BY CONSTRUCTION, INHERITED RATHER THAN RESTATED. The reader it
 * drives never submits, and every control it clicks has already been passed by
 * a policy whose default is refusal. The driver adds one rule of its own: it
 * records what it declined, because a map that silently skips half a page
 * overstates its coverage and every claim drawn from it inherits that.
 */

import {
  Frontier,
  shouldFollow,
  signatureOf,
  budgetExceeded,
  DEFAULT_BUDGET,
  type ExploreBudget,
} from "./explore";
import { partitionByPolicy, type ClickCandidate } from "./click-policy";
import type { MappedSurface, MapCoverage, MappedForm } from "./types";

/** What the driver needs a page to tell it. One visit, one answer. */
export interface ReadSurface {
  url: string;
  status: number | null;
  title: string | null;
  headings: string[];
  /** Absolute URLs of ordinary links. */
  links: string[];
  forms: MappedForm[];
  tables: { caption: string | null; columns: string[]; rowCount: number }[];
  /** Every clickable control, unfiltered. The policy decides, not the reader. */
  controls: ClickCandidate[];
  loadMs: number;
}

export interface SurfaceReader {
  read(url: string): Promise<ReadSurface>;
  /**
   * Click a control on the surface just read and report where it landed.
   *
   * Optional, because a reader without it still produces a link-only map, and
   * a link-only map is what this product had before. Returning null means the
   * click changed no URL, which is the common case for a tab and is not a
   * failure: the surface was already counted.
   */
  clickTo?(control: ClickCandidate): Promise<string | null>;
}

export interface WalkResult {
  surfaces: MappedSurface[];
  coverage: MapCoverage;
}

export interface WalkOptions {
  budget?: ExploreBudget;
  /**
   * Path every surface must sit under. Derived from the entry URL's first
   * segment when omitted, which is right for a multi-tenant host and wrong
   * for a deep link into a single-tenant one.
   *
   * Pass null to walk the whole origin. The map reports every
   * "outside-tenant" refusal, so an over-confined run is visible in its own
   * coverage rather than looking like a small system.
   */
  confineTo?: string | null;
  now?: () => number;
  /** Surfaced so a caller can report progress without this file knowing how. */
  onSurface?: (surface: MappedSurface) => void;
}

export async function walkSystem(
  entryUrl: string,
  reader: SurfaceReader,
  opts: WalkOptions = {},
): Promise<WalkResult> {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  const seen = new Set<string>();
  const frontier = new Frontier(seen);
  const surfaces: MappedSurface[] = [];
  const skipped: MapCoverage["skipped"] = [];
  let maxDepthReached = 0;

  const origin = (() => {
    try {
      return new URL(entryUrl).origin;
    } catch {
      return "";
    }
  })();
  if (!origin) {
    return {
      surfaces: [],
      coverage: {
        surfacesReached: 0,
        frontierRemaining: 0,
        skipped: [{ signature: entryUrl, reason: "not-http" }],
        maxDepthReached: 0,
        /* The entry URL itself was unusable, which is not an exhausted
           frontier: nothing was ever walkable. */
        stopReason: "error",
        durationMs: 0,
      },
    };
  }

  /* CONFINE TO THE TENANT THE ENTRY URL NAMES.
   *
   * On a shared-domain SaaS the origin is the vendor, not the customer. The
   * first path segment is the org, and everything worth mapping sits under it.
   * Without this the walk left a customer's org for the vendor's documentation
   * and spent 17 of 40 surfaces there, with a frontier of 301 because a docs
   * site is effectively unbounded.
   *
   * Absent when the entry URL has no path, which is an ordinary single-tenant
   * system where the origin already is the boundary. */
  const firstSegment =
    opts.confineTo === null
      ? undefined
      : (opts.confineTo ??
        (() => {
          try {
            const seg = new URL(entryUrl).pathname.split("/").filter(Boolean)[0];
            return seg ? `/${seg}` : undefined;
          } catch {
            return undefined;
          }
        })());

  frontier.add(entryUrl, 0);

  /* Recorded once per signature. A link to the same place from forty rows is
     one decision, and forty identical lines would bury the ones that matter. */
  const noteSkip = (target: string, reason: string) => {
    const sig = signatureOf(target);
    if (skipped.some((s) => s.signature === sig && s.reason === reason)) return;
    skipped.push({ signature: sig, reason });
  };

  /* The honest default: if the loop ends without a budget stopping it, there
     was nothing left to visit. */
  let stopReason: MapCoverage["stopReason"] = "frontier-exhausted";

  for (;;) {
    const exceeded = budgetExceeded(
      { surfaces: surfaces.length, depth: maxDepthReached, elapsedMs: now() - startedAt },
      budget,
    );
    if (exceeded) {
      stopReason = exceeded;
      break;
    }

    const item = frontier.next();
    if (!item) break;

    const sig = signatureOf(item.url);
    if (seen.has(sig)) continue;
    seen.add(sig);

    let read: ReadSurface;
    try {
      read = await reader.read(item.url);
    } catch (err) {
      /* A page that will not load is a finding, not a reason to stop: a broken
         screen inside somebody's system is exactly what an assessment is for. */
      noteSkip(item.url, `unreadable: ${(err as Error).message.slice(0, 60)}`);
      continue;
    }

    maxDepthReached = Math.max(maxDepthReached, item.depth);

    /* CONTROLS ARE JUDGED BEFORE ANYTHING IS TOUCHED. Everything refused is
       recorded with its reason, so the map can say what it chose not to open
       rather than quietly presenting a partial picture as a whole one. */
    const { clickable, declined } = partitionByPolicy(read.controls);
    for (const d of declined) {
      const name = (d.candidate.text || d.candidate.label || "unnamed control").slice(0, 40);
      noteSkip(`${item.url}#${name}`, d.because);
    }

    const onward = new Set<string>();

    for (const link of read.links) {
      const verdict = shouldFollow(link, {
        origin,
        seen,
        depth: item.depth,
        maxDepth: budget.maxDepth,
        confineTo: firstSegment,
      });
      if (verdict.follow) {
        onward.add(signatureOf(link));
        frontier.add(link, item.depth + 1);
      } else if (verdict.reason !== "already-seen") {
        /* already-seen is not a decision worth reporting: it means the map
           worked. The others are places deliberately not looked at. */
        noteSkip(link, verdict.reason);
      }
    }

    /* CLICKING IS WHAT SEES INSIDE AN APP. A dashboard keeps its structure
       behind tabs and client-side routing, so a link-only walk maps the shell
       and reports it as the system. Only controls the policy passed are
       touched, and only after the page has been read. */
    if (reader.clickTo) {
      for (const control of clickable) {
        if (surfaces.length + frontier.size >= budget.maxSurfaces) break;
        let landed: string | null = null;
        try {
          landed = await reader.clickTo(control);
        } catch (err) {
          noteSkip(`${item.url}#${control.text || "control"}`, `click failed: ${(err as Error).message.slice(0, 40)}`);
          continue;
        }
        /* Null means the URL did not change, which a tab often does not. The
           surface was already counted; nothing to add. */
        if (!landed) continue;
        const verdict = shouldFollow(landed, {
          origin,
          seen,
          depth: item.depth,
          maxDepth: budget.maxDepth,
          confineTo: firstSegment,
        });
        if (verdict.follow) {
          onward.add(signatureOf(landed));
          frontier.add(landed, item.depth + 1);
        } else if (verdict.reason !== "already-seen") {
          noteSkip(landed, verdict.reason);
        }
      }
    }

    const surface: MappedSurface = {
      url: read.url,
      signature: sig,
      title: read.title,
      depth: item.depth,
      headings: read.headings,
      linksTo: [...onward],
      forms: read.forms,
      tables: read.tables,
      status: read.status,
      loadMs: read.loadMs,
    };
    surfaces.push(surface);
    opts.onSurface?.(surface);
  }

  return {
    surfaces,
    coverage: {
      surfacesReached: surfaces.length,
      /* NON-ZERO MEANS THE MAP IS INCOMPLETE, and every claim drawn from it
         inherits that. Reported rather than rounded away. */
      frontierRemaining: frontier.size,
      skipped,
      maxDepthReached,
      stopReason,
      durationMs: now() - startedAt,
    },
  };
}
