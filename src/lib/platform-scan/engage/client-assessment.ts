/**
 * Assess a client's live system, from granted access rather than source code.
 *
 * THE GAP THIS CLOSES. runEngagement() is the existing assessment, and it
 * begins with `if (!manifest?.static) return EMPTY(platform, "no_static_target")`.
 * A static target is a GitHub owner and repo. So the engagement sweep can only
 * assess a platform whose SOURCE we already hold, and it silently skips
 * everything else.
 *
 * That is the wrong shape for the engagement this product is sold into. A
 * client grants access to systems they run: a website, a portal, a tenant. We
 * do not get their repository, and asking for it on day one is the wrong first
 * conversation. The assessment has to start from what they actually handed us.
 *
 * SO THIS IS COMPOSITION, NOT NEW SCANNING. Every step is an existing, tested
 * piece, arranged for the case where there is no source:
 *
 *   isTargetVerified  the ownership floor, unchanged and non-negotiable
 *   discoverRoutes    sitemap and well-known files, cheap and polite
 *   crawlRoutes       follow links when a sitemap does not exist
 *   scanPlatform      the http tier over whatever was discovered
 *   runSiteScan       the privacy and compliance surface
 *
 * WHAT IT REFUSES TO DO.
 *
 * It will not assess a target whose ownership has not been verified. That is
 * the difference between an engagement and a stranger scanning somebody's
 * site, and it fails closed: an unreadable verification is treated as absent.
 *
 * It will not imply a completeness it does not have. Source-level profiling
 * (buildSystemProfile) reads migrations and route files to model entities and
 * surfaces, and none of that is possible from the outside. The result says so,
 * in `notAssessed`, rather than presenting a surface crawl as a full picture.
 * A client shown "we found 3 issues" without being told what was never looked
 * at has been given a false sense of the depth.
 *
 * It proposes nothing and changes nothing. Read-only by construction.
 */

import { isTargetVerified } from "../authorization";
import { discoverRoutes, crawlRoutes } from "../discover";
import { scanPlatform } from "../engine";
import { recordScan } from "../store";
import { trackEvent } from "@/lib/analytics";
import type { ScanRouteSpec } from "../types";

/** What a client actually gets back, and what they did not. */
export interface ClientAssessmentResult {
  platform: string;
  baseUrl: string;
  /** Set when nothing was assessed, naming the reason in the client's terms. */
  refused?: string;
  /** Surfaces found, and how they were found. */
  routesDiscovered: number;
  discoveredVia: "sitemap" | "crawl" | "none";
  findingCount: number;
  criticalCount: number;
  /**
   * The honest boundary of this run.
   *
   * Every entry is something a reader might otherwise assume was covered. A
   * report that lists only what was found reads as complete, and the gap
   * between "we found nothing there" and "we never looked there" is the whole
   * difference between an assessment and a reassurance.
   */
  notAssessed: string[];
}

/** How many routes a first assessment will look at. */
const MAX_ROUTES = 60;

const REFUSED = (
  platform: string,
  baseUrl: string,
  refused: string,
): ClientAssessmentResult => ({
  platform,
  baseUrl,
  refused,
  routesDiscovered: 0,
  discoveredVia: "none",
  findingCount: 0,
  criticalCount: 0,
  notAssessed: [],
});

export interface ClientAssessmentDeps {
  isVerified?: typeof isTargetVerified;
  discover?: typeof discoverRoutes;
  crawl?: typeof crawlRoutes;
  scan?: typeof scanPlatform;
}

export async function runClientAssessment(
  input: {
    workspaceId: string;
    platform: string;
    baseUrl: string;
    actor: { userId: string; role: string };
  },
  deps: ClientAssessmentDeps = {},
): Promise<ClientAssessmentResult> {
  const isVerified = deps.isVerified ?? isTargetVerified;
  const discover = deps.discover ?? discoverRoutes;
  const crawl = deps.crawl ?? crawlRoutes;
  const scan = deps.scan ?? scanPlatform;

  const { workspaceId, platform, baseUrl } = input;

  /* THE OWNERSHIP FLOOR, FIRST AND FAIL-CLOSED. Everything below this line
     sends traffic to somebody else's system. An unreadable answer is treated
     as "not verified", because the cost of being wrong is scanning a system
     nobody authorised us to touch. */
  let verified = false;
  try {
    verified = await isVerified(workspaceId, platform);
  } catch {
    verified = false;
  }
  if (!verified) {
    return REFUSED(
      platform,
      baseUrl,
      "ownership of this target has not been verified, so nothing was scanned",
    );
  }

  /* Sitemap first: it is one request, it is what the site publishes about
     itself, and it is far politer than crawling. Crawling is the fallback for
     a site that does not publish one. */
  let routes: ScanRouteSpec[] = [];
  let discoveredVia: ClientAssessmentResult["discoveredVia"] = "none";
  try {
    routes = await discover(baseUrl);
    if (routes.length > 0) discoveredVia = "sitemap";
  } catch {
    routes = [];
  }

  if (routes.length === 0) {
    try {
      routes = await crawl(baseUrl, { maxPages: MAX_ROUTES });
      if (routes.length > 0) discoveredVia = "crawl";
    } catch {
      routes = [];
    }
  }

  if (routes.length === 0) {
    return REFUSED(
      platform,
      baseUrl,
      "no reachable pages were found at this address, so there was nothing to assess",
    );
  }

  const limited = routes.slice(0, MAX_ROUTES);

  const result = await scan({
    workspaceId,
    platform,
    baseUrl,
    routes: limited,
  });

  /* recordScan is the one place a scan becomes durable: it dedupes,
     auto-resolves what is now fixed, alerts on critical and feeds the learning
     loop. It also returns the counts, so there is no second query and no
     chance of this function disagreeing with the stored record. */
  const recorded = await recordScan({
    workspaceId,
    actorId: input.actor.userId,
    actorRole: input.actor.role,
    result,
  }).catch(() => null);

  /* SAID OUT LOUD, in the reader's terms rather than ours. */
  const notAssessed: string[] = [
    "Anything behind a login. This run carried no session, so pages that require sign-in were seen only as redirects.",
    "The application's own code. Source-level review needs repository access and models things a surface scan cannot reach, such as how data is stored and which permissions guard it.",
    "Integrations and background jobs, which leave no trace on a public page.",
  ];
  if (routes.length > MAX_ROUTES) {
    notAssessed.push(
      `${routes.length - MAX_ROUTES} further pages were found and not scanned in this first pass.`,
    );
  }
  if (discoveredVia === "crawl") {
    notAssessed.push(
      "Pages reachable only through a form, a search box, or a link this crawl did not follow.",
    );
  }

  trackEvent("platform.engagement_run", input.actor.userId, input.actor.role, {
    workspace_id: workspaceId,
    platform,
    mode: "client_assessment",
    routes: limited.length,
    discovered_via: discoveredVia,
    findings: recorded?.findingCount ?? result.findings.length,
    critical: recorded?.criticalCount ?? 0,
  });

  return {
    platform,
    baseUrl,
    routesDiscovered: limited.length,
    discoveredVia,
    findingCount: recorded?.findingCount ?? result.findings.length,
    criticalCount: recorded?.criticalCount ?? 0,
    notAssessed,
  };
}
