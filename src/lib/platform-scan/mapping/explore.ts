/**
 * Deciding where to look next, and knowing when to stop lying about coverage.
 *
 * Pure. The browser work is a thin driver on top; every rule that decides what
 * gets visited, what gets refused, and what the map may claim lives here where
 * it can be tested without a client system.
 *
 * THE THREE THINGS THAT MAKE THIS SAFE TO POINT AT SOMEONE'S PRODUCTION SYSTEM
 *
 * 1. It follows links. It does not click buttons, submit forms, or activate
 *    anything that could change state. On a live Salesforce instance a stray
 *    click can convert a lead, send an email, or fire a workflow, and "we were
 *    only mapping" does not undo it.
 *
 * 2. It never leaves the origin it was authorised for. A client system links
 *    outward constantly — docs, status pages, vendor sites — and following
 *    those means scanning systems nobody authorised.
 *
 * 3. It refuses anything that looks like it ends the session or destroys
 *    something, by name. Logging ourselves out mid-map is merely annoying;
 *    following /delete because it happened to be a link is not.
 *
 * SIGNATURES, NOT URLS
 *
 * A CRM has one Account screen and a hundred thousand accounts. Treating each
 * record as a surface produces a map that is enormous, useless, and mostly
 * duplicate. Volatile segments collapse to a placeholder so the map describes
 * STRUCTURE — which is what a report about automation opportunities needs.
 */
import type { MapCoverage, MappedSurface, StopReason, SystemMap, UserPath } from "./types";

export interface ExploreBudget {
  maxSurfaces: number;
  maxDepth: number;
  maxDurationMs: number;
}

export const DEFAULT_BUDGET: ExploreBudget = {
  // Enough to describe a system's shape, small enough to finish inside a
  // sensible window and to stay a polite guest on someone's instance.
  maxSurfaces: 120,
  maxDepth: 4,
  maxDurationMs: 8 * 60 * 1000,
};

/** Path segments that mean "this is one record, not one screen". */
const VOLATILE = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /* A record id, which needs a DIGIT. Matching any 15-18 character
     alphanumeric run also matches ordinary words: mapping a real tenant on
     2026-08-30, "porscheacademyus" is 16 characters and became ":id", so
     every surface in the map read /:id/home and the org disappeared from its
     own map. Real ids from Salesforce, Cognito and the rest all carry digits;
     a lowercase slug does not. */
  /^(?=[a-zA-Z0-9]{15,18}$)(?=.*\d)[a-zA-Z0-9]+$/,
  /^\d{4}-\d{2}-\d{2}$/, // date
];

/**
 * Collapse a URL to the surface it represents.
 *
 * Query strings are dropped except for the keys that select a VIEW rather than
 * a record — a report page and a list page can differ only by ?view=, and
 * losing that would merge two genuinely different screens.
 */
const VIEW_KEYS = new Set(["view", "tab", "mode", "filter", "type"]);

export function signatureOf(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => (VOLATILE.some((re) => re.test(seg)) ? ":id" : seg.toLowerCase()));

  const viewParams = [...url.searchParams.entries()]
    .filter(([k]) => VIEW_KEYS.has(k.toLowerCase()))
    .map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`)
    .sort();

  return `/${segments.join("/")}${viewParams.length ? `?${viewParams.join("&")}` : ""}`;
}

/**
 * Links whose names say they do something. Refused by NAME as well as by
 * method, because a destructive action reached by a GET link is still
 * destructive and the read-only floor cannot see intent.
 */
const DANGEROUS = /\b(logout|signout|delete|remove|destroy|revoke|deactivate|purge|reset|unsubscribe|cancel)\b/i;

/**
 * Split camelCase before matching.
 *
 * Enterprise systems name actions `deleteUser`, `deactivateAccount`,
 * `purgeRecords`. A plain word-boundary match misses every one of them, because
 * the verb is glued to its noun — `/setup/deleteUser` sailed through the first
 * version of this check, which is exactly the link that must never be followed.
 */
export function normalizeForDangerCheck(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_+.]/g, "-")
    .toLowerCase();
}

export type SkipReason =
  | "off-origin"
  | "outside-tenant"
  | "dangerous"
  | "already-seen"
  | "not-http"
  | "too-deep";

/** Should this link be followed? Returns the reason when not, so the map can
 *  report what it deliberately did not look at. */
/**
 * Is this path inside that one, on a segment boundary?
 *
 * A bare startsWith is wrong on a multi-tenant host and wrong in the dangerous
 * direction: "/acme" prefixes "/acmecorp", so confining a map to one client's
 * org would happily walk another client's. Caught while testing the confinement
 * itself, before it ever ran.
 */
export function withinPath(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(base);
}

export function shouldFollow(
  candidate: string,
  ctx: {
    origin: string;
    seen: ReadonlySet<string>;
    depth: number;
    maxDepth: number;
    /**
     * The path every surface must sit under, on a shared-domain SaaS.
     *
     * SAME ORIGIN IS TOO LOOSE FOR A MULTI-TENANT PRODUCT. Mapping a real
     * tenant on 2026-08-30, the walk left the customer's org and spent 17 of
     * 40 surfaces inside the vendor's own documentation, because
     * cognitoforms.com serves /porscheacademyus and /support from one host.
     *
     * The cost is not only wasted surfaces. The frontier finished at 301
     * because a documentation site is effectively unbounded, the form count
     * filled with the vendor's newsletter and support-chat widgets, and the
     * refusal list filled with their controls rather than the client's. A map
     * of somebody else's marketing site is worse than a small map.
     */
    confineTo?: string;
  },
): { follow: true } | { follow: false; reason: SkipReason } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { follow: false, reason: "not-http" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { follow: false, reason: "not-http" };
  if (url.origin !== ctx.origin) return { follow: false, reason: "off-origin" };
  if (ctx.confineTo && !withinPath(url.pathname, ctx.confineTo)) {
    return { follow: false, reason: "outside-tenant" };
  }
  const inspectable = normalizeForDangerCheck(`${url.pathname}${url.search}`);
  if (DANGEROUS.test(inspectable)) return { follow: false, reason: "dangerous" };
  if (ctx.depth >= ctx.maxDepth) return { follow: false, reason: "too-deep" };
  if (ctx.seen.has(signatureOf(candidate))) return { follow: false, reason: "already-seen" };
  return { follow: true };
}

export interface FrontierItem {
  url: string;
  depth: number;
}

/**
 * The queue of places still worth visiting.
 *
 * Breadth-first on purpose. A depth-first walk of a CRM disappears into one
 * record's related lists and produces a deep, narrow map of nothing useful;
 * breadth-first reaches the navigation tree first, which is the part that
 * describes the system.
 */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly queued = new Set<string>();

  constructor(private readonly seen: Set<string>) {}

  add(url: string, depth: number): boolean {
    const sig = signatureOf(url);
    if (this.seen.has(sig) || this.queued.has(sig)) return false;
    this.queued.add(sig);
    this.queue.push({ url, depth });
    return true;
  }

  next(): FrontierItem | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.queue.length;
  }
}

/** Has the budget run out, and which one? */
export function budgetExceeded(
  state: { surfaces: number; depth: number; elapsedMs: number },
  budget: ExploreBudget,
): StopReason | null {
  if (state.surfaces >= budget.maxSurfaces) return "page-budget";
  if (state.elapsedMs >= budget.maxDurationMs) return "time-budget";
  if (state.depth > budget.maxDepth) return "depth-budget";
  return null;
}

/**
 * User paths, derived from the graph rather than guessed.
 *
 * A path is only reported as VERIFIED when every step is a surface we actually
 * reached. Anything assembled across a gap is a hypothesis, and saying so is
 * the difference between a report a client can act on and one they later find
 * described a screen that does not exist.
 */
export function derivePaths(surfaces: readonly MappedSurface[]): UserPath[] {
  const bySig = new Map(surfaces.map((s) => [s.signature, s]));
  const paths: UserPath[] = [];

  // A surface with a form is an endpoint someone is trying to REACH. The route
  // to it is the user path worth reporting.
  for (const surface of surfaces) {
    if (surface.forms.length === 0) continue;
    const chain = [surface.signature];
    let cursor = surface;
    const guard = new Set([surface.signature]);

    // Walk back up to whatever links here, shallowest first.
    for (let hop = 0; hop < 4; hop++) {
      const parent = surfaces
        .filter((s) => s.linksTo.includes(cursor.signature) && !guard.has(s.signature))
        .sort((a, b) => a.depth - b.depth)[0];
      if (!parent) break;
      guard.add(parent.signature);
      chain.unshift(parent.signature);
      cursor = parent;
    }

    if (chain.length < 2) continue;
    paths.push({
      name: `${surface.forms[0].name} via ${chain.length} step${chain.length === 1 ? "" : "s"}`,
      steps: chain,
      verified: chain.every((sig) => bySig.has(sig)),
    });
  }

  return paths.sort((a, b) => a.steps.length - b.steps.length).slice(0, 25);
}

/**
 * The sentence a person reads first.
 *
 * Leads with what was NOT covered whenever anything was left, because every
 * recommendation drawn from this map inherits its incompleteness and the reader
 * needs that before they read the findings, not after.
 */
export function describeCoverage(coverage: MapCoverage, platform: string): string {
  const base = `Mapped ${coverage.surfacesReached} screen${coverage.surfacesReached === 1 ? "" : "s"} of ${platform}`;

  if (coverage.stopReason === "frontier-exhausted" && coverage.frontierRemaining === 0) {
    return `${base}. Every screen reachable by following links from the entry point was visited.`;
  }
  const why =
    coverage.stopReason === "page-budget"
      ? "the page limit was reached"
      : coverage.stopReason === "time-budget"
        ? "the time limit was reached"
        : coverage.stopReason === "depth-budget"
          ? "the depth limit was reached"
          : coverage.stopReason === "refused"
            ? "the gate refused to continue"
            : "the run ended early";

  return `${base}, and stopped because ${why}. ${coverage.frontierRemaining} more were still queued, so this is a partial map — treat anything below as covering what was seen, not the whole system.`;
}

/** Assemble the finished map. Coverage and headline are computed together so a
 *  map cannot be built without stating what it missed. */
export function buildSystemMap(input: {
  platform: string;
  entryUrl: string;
  surfaces: MappedSurface[];
  entities: SystemMap["entities"];
  integrations: SystemMap["integrations"];
  coverage: MapCoverage;
  now: string;
}): SystemMap {
  return {
    platform: input.platform,
    entryUrl: input.entryUrl,
    surfaces: input.surfaces,
    entities: input.entities,
    integrations: input.integrations,
    paths: derivePaths(input.surfaces),
    coverage: input.coverage,
    generatedAt: input.now,
    headline: describeCoverage(input.coverage, input.platform),
  };
}
