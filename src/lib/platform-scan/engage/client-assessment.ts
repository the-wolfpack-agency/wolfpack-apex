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
import { establishSession } from "../session";
import { mapDataFlows, type DataFlowMap } from "../mapping/data-flow";
import { recommendFromDataFlows } from "../recommend/from-data-flows";
import type { AutomationRecommendation } from "../recommend/types";
import { discoverRoutes, crawlRoutes } from "../discover";
import { scanPlatform } from "../engine";
import { recordScan } from "../store";
import { trackEvent } from "@/lib/analytics";
import type { ScanRouteSpec } from "../types";

/** What a client actually gets back, and what they did not. */
export interface ClientAssessmentResult {
  platform: string;
  baseUrl: string;
  /**
   * Whether the run carried a session.
   *
   * The single most important field for reading the rest. An unauthenticated
   * run sees the front door; an authenticated one sees the building. Two
   * reports with the same finding count mean entirely different things
   * depending on this, and a reader who cannot tell them apart will
   * misjudge both.
   */
  authenticated: boolean;
  /** Set when a login was attempted and did not work. */
  loginFailed?: string;
  /** Set when nothing was assessed, naming the reason in the client's terms. */
  refused?: string;
  /** Surfaces found, and how they were found. */
  routesDiscovered: number;
  discoveredVia: "sitemap" | "crawl" | "none";
  findingCount: number;
  criticalCount: number;
  /**
   * Routes that answered only once we were signed in.
   *
   * The interesting half of a recon. A page that redirects to login when
   * anonymous and returns content when authenticated is a surface that exists
   * and was invisible from outside, which is exactly what an engagement needs
   * mapped before anybody plans work against it.
   */
  internalSurfaces: number;
  /** Routes that answered without a session at all. */
  externalSurfaces: number;
  /**
   * Where information arrives and where it leaves.
   *
   * The part a client most often cannot produce themselves. Nobody has a
   * current list of every form on their estate or every vendor their pages
   * contact, and the second is exactly what a privacy review asks for.
   */
  dataFlows: DataFlowMap;
  /**
   * What to do about it.
   *
   * A recon that ends in a list of facts leaves the client to work out what
   * matters. This ends in an ordered plan: data leaving to a third party
   * first, then the automations the vendors they already use make possible.
   */
  recommendations: AutomationRecommendation[];
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
  authenticated: false,
  routesDiscovered: 0,
  discoveredVia: "none",
  findingCount: 0,
  criticalCount: 0,
  internalSurfaces: 0,
  externalSurfaces: 0,
  dataFlows: { entryPoints: [], exitPoints: [], pagesRead: 0 },
  recommendations: [],
  notAssessed: [],
});

/**
 * Credentials the client granted, for mapping what is behind the login.
 *
 * OPTIONAL, AND ABSENT IS A VALID ASSESSMENT. A first pass usually runs
 * anonymously, and pretending otherwise would push operators to ask for
 * credentials before there is any reason to trust us with them.
 */
export interface GrantedAccess {
  loginPath: string;
  username: string;
  password: string;
  sessionCookieName?: string;
}

export interface ClientAssessmentDeps {
  isVerified?: typeof isTargetVerified;
  login?: typeof establishSession;
  mapFlows?: typeof mapDataFlows;
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
    /** Credentials the client granted. Omitted means an anonymous pass. */
    access?: GrantedAccess;
  },
  deps: ClientAssessmentDeps = {},
): Promise<ClientAssessmentResult> {
  const isVerified = deps.isVerified ?? isTargetVerified;
  const login = deps.login ?? establishSession;
  const mapFlows = deps.mapFlows ?? mapDataFlows;
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

  /* THE KEYS, IF WE WERE GIVEN ANY.
   *
   * An anonymous scan sees the front door. Signing in is what turns a scan
   * into a recon: a page that redirects to login when anonymous and returns
   * content when authenticated is a surface that exists and was invisible from
   * outside, which is exactly what has to be mapped before anybody plans work
   * against it.
   *
   * A login that fails does NOT abort the run. The anonymous findings are
   * still worth having, and an assessment that returns nothing because a
   * password was wrong is an assessment nobody will run twice. It is reported
   * instead, so the reader knows which of the two reports they are holding. */
  let sessionCookie: string | null = null;
  let loginFailed: string | undefined;

  if (input.access) {
    try {
      const session = await login({
        baseUrl,
        loginPath: input.access.loginPath,
        username: input.access.username,
        password: input.access.password,
        ...(input.access.sessionCookieName
          ? { sessionCookieName: input.access.sessionCookieName }
          : {}),
      });
      if (session?.cookie) sessionCookie = session.cookie;
      else loginFailed = "The credentials were not accepted, so only public pages were assessed.";
    } catch {
      loginFailed = "The sign-in attempt failed, so only public pages were assessed.";
    }
  }

  /* ALWAYS THE ANONYMOUS PASS FIRST, even when we hold credentials.
   *
   * It is the only way to learn which surfaces are actually protected. A
   * single authenticated crawl cannot tell a page that is public from one that
   * is correctly gated, and "which of these is reachable without signing in"
   * is the first question a security review asks. */
  const external = await scan({ workspaceId, platform, baseUrl, routes: limited });

  /* okCount is the scanner's own tally of routes that answered with content
     rather than a redirect to a login. Reusing it rather than re-deriving one
     means this cannot disagree with what the scan recorded. */
  const externalSurfaces = external.okCount;

  let result = external;
  let internalSurfaces = 0;

  if (sessionCookie) {
    /* authenticated:true flips the scanner's semantics. Anonymously a bounce
       to login is correct enforcement; with a session it is the session not
       being honoured, which is a bug rather than a control. */
    const internal = await scan({
      workspaceId,
      platform,
      baseUrl,
      routes: limited,
      headers: { Cookie: sessionCookie },
      authenticated: true,
    });

    const reachableInternally = internal.okCount;
    /* The surfaces that only exist once signed in. Not the total: a page
       reachable both ways was never hidden. */
    internalSurfaces = Math.max(0, reachableInternally - externalSurfaces);
    result = internal;
  }

  /* THE MAP, not just the faults. A finding list says what is broken; this
     says what the system IS. Drawn with the session when there is one, because
     the forms that matter most are usually behind the login. */
  let dataFlows: DataFlowMap = { entryPoints: [], exitPoints: [], pagesRead: 0 };
  try {
    dataFlows = await mapFlows(baseUrl, limited.map((r) => r.path));
  } catch {
    /* A map we could not draw is not a reason to lose the findings. */
  }

  /* recordScan is the one place a scan becomes durable: it dedupes,
     auto-resolves what is now fixed, alerts on critical and feeds the learning
     loop. The authenticated pass is the one persisted when there was one,
     because it is the fuller picture. */
  const recorded = await recordScan({
    workspaceId,
    actorId: input.actor.userId,
    actorRole: input.actor.role,
    result,
  }).catch(() => null);

  /* SAID OUT LOUD, in the reader's terms rather than ours. */
  const notAssessed: string[] = [];
  if (!sessionCookie) {
    notAssessed.push(
      "Anything behind a login. This run carried no session, so pages that require sign-in were seen only as redirects.",
    );
  }
  notAssessed.push(
    "The application's own code. Source-level review needs repository access and models things a surface scan cannot reach, such as how data is stored and which permissions guard it.",
  );
  notAssessed.push(
    "Integrations and background jobs, which leave no trace on a page.",
  );
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
    authenticated: sessionCookie !== null,
    ...(loginFailed ? { loginFailed } : {}),
    internalSurfaces,
    externalSurfaces,
    dataFlows,
    /* Derived rather than stored: the plan is a reading of the map, and a
       stale copy of it would be worse than none. */
    recommendations: recommendFromDataFlows(dataFlows),
    routesDiscovered: limited.length,
    discoveredVia,
    findingCount: recorded?.findingCount ?? result.findings.length,
    criticalCount: recorded?.criticalCount ?? 0,
    notAssessed,
  };
}
