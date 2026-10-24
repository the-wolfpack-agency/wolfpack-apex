/**
 * Forcefield for the Web - the drop-in site shim.
 *
 * Onboarding a site is now one line in its middleware:
 *
 *     event.waitUntil(forcefieldMonitor({ site: "aidanmulready", req }));
 *
 * Everything else - activation, the ruleset, the classify, the forward - lives
 * here and is shared. It is DARK BY DEFAULT (off unless FORCEFIELD_WEB === "on"),
 * MONITOR-ONLY (only forwards an observation, never blocks), and FAIL-OPEN (the
 * whole body is wrapped; it never throws and never touches the response). The
 * ruleset comes from the central endpoint with a fail-open fetch, so a site with
 * no FORCEFIELD_RULESET_URL simply runs on the bundled defaults.
 *
 * Env it reads (all optional; missing any => no forward):
 *   FORCEFIELD_WEB=on            activation kill-switch (dark by default)
 *   SITE_ANALYTICS_INGEST_TOKEN  shared ingest secret
 *   FORCEFIELD_INGEST_URL        the CONFIGURED absolute ingest URL (never derived
 *                                from the request - that would be SSRF)
 *   FORCEFIELD_RULESET_URL       central ruleset endpoint (unset => bundled defaults)
 */
import { observeRequest, withEnforcement, type ObserveInput } from "./observe";
import { fetchRuleset, type ForcefieldRuleset } from "./ruleset";
import { decideEnforcement, type EnforcementDecision } from "./enforce";

/** The subset of a NextRequest this needs - structural, so a NextRequest fits
 *  without importing framework types (keeps the module edge- and test-friendly). */
export interface MonitorRequestLike {
  method: string;
  headers: Headers;
  nextUrl: { pathname: string; search?: string };
  /** The full request URL (absolute). Used as the authoritative source for the
   *  query string when scanning for payloads, because nextUrl.search can be
   *  empty in some edge runtimes. Optional so tests can omit it. */
  url?: string;
}

export interface ForcefieldArgs {
  site: string;
  req: MonitorRequestLike;
  /** SITE-ATTESTED: the site verified a real session / service credential for
   *  this request (never inferred from header presence). */
  authenticated?: boolean;
  /** The platform the site runs on (e.g. "wordpress"), so its native paths are
   *  not reported as recon. */
  platform?: string;
  /** True when the caller did NOT run forcefieldGuard for this request (e.g. the
   *  Forcefield control-plane paths), so the monitor never records a block that
   *  did not happen. */
  skipEnforcement?: boolean;
}

/** The header a VERIFIED synthetic monitor (our own Playwright smoke tests,
 *  canaries, uptime monitors) presents. Its value is compared and discarded:
 *  never logged, never forwarded (only header NAMES ever leave this module). */
export const SYNTHETIC_HEADER = "x-forcefield-synthetic";

/** Constant-time string equality without Node's crypto (the portable core runs
 *  in any edge runtime). Length is not secret; the per-char compare does not
 *  short-circuit. Exported so a host middleware comparing its own service
 *  secrets at the edge reuses this one primitive. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Synthetic-monitor attestation. True only when FORCEFIELD_SYNTHETIC_TOKEN is
 * configured (>= 32 chars; shorter or unset = feature OFF) and the request's
 * x-forcefield-synthetic header equals it. A headless Playwright check shares
 * its header shape with every other headless Chrome, so a distributed operator
 * block on that shape turned our own production smoke tests away; this lets a
 * monitor PROVE it is ours instead of us weakening the block. Never throws.
 */
export function isSyntheticMonitor(headers: Headers): boolean {
  try {
    const expected = process.env.FORCEFIELD_SYNTHETIC_TOKEN ?? "";
    if (expected.length < 32) return false;
    const presented = headers.get(SYNTHETIC_HEADER) ?? "";
    if (!presented) return false;
    return constantTimeEqual(presented, expected);
  } catch {
    return false;
  }
}

/** The request target the payload scan sees: path + query. The full req.url is
 *  authoritative (nextUrl.search can be empty at the edge); the host is dropped.
 *  Falls back to nextUrl.search when req.url is absent (tests). */
export function requestTarget(req: MonitorRequestLike): string {
  let rawUrl = req.nextUrl.pathname + (req.nextUrl.search ?? "");
  if (req.url) {
    try {
      const u = new URL(req.url);
      rawUrl = u.pathname + u.search;
    } catch {
      /* keep the nextUrl-derived value */
    }
  }
  return rawUrl;
}

/** Build the ObserveInput for a request (one derivation shared by monitor and
 *  guard so the recorded event and the block decision see the same request). */
function observeInputFor(args: ForcefieldArgs): ObserveInput {
  const { req } = args;
  // Client IP for hosting classification + crawler verification only - used in
  // observeRequest/decideEnforcement and discarded; never stored. First hop of
  // x-forwarded-for is the client.
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim();
  return {
    site: args.site,
    path: req.nextUrl.pathname,
    rawUrl: requestTarget(req),
    method: req.method,
    userAgent: req.headers.get("user-agent") ?? "",
    country: req.headers.get("x-vercel-ip-country") ?? "",
    headerNames: Array.from(req.headers.keys()),
    accept: req.headers.get("accept") ?? "",
    secFetchDest: req.headers.get("sec-fetch-dest") ?? "",
    ip: ip || undefined,
    authenticated: args.authenticated === true || isSyntheticMonitor(req.headers),
    platform: args.platform,
    nowMs: Date.now(),
  };
}

function decide(input: ObserveInput, ruleset: ForcefieldRuleset): EnforcementDecision {
  // decideEnforcement computes the operator fingerprint itself (header shape
  // bound to the client's tool), matching what observe.ts stamps on events, so
  // an admin block distributed via ruleset.blockedFingerprints is enforced here.
  return decideEnforcement(
    {
      path: input.path,
      rawUrl: input.rawUrl,
      method: input.method,
      userAgent: input.userAgent,
      headerNames: input.headerNames,
      authenticated: input.authenticated,
      ip: input.ip,
    },
    ruleset,
    { blockedFingerprints: ruleset.blockedFingerprints },
  );
}

/**
 * Classify one request and forward the observation to the analytics ingest.
 * Returns a promise the caller should hand to event.waitUntil so the forward
 * survives the response. Never throws; a no-op unless fully configured + enabled.
 * When enforcement is on (FORCEFIELD_ENFORCE=on) it recomputes the same pure
 * block decision the guard acted on and stamps it, so a blocked request is
 * recorded AS blocked (and recorded at all, even with no other tell).
 */
export async function forcefieldMonitor(args: ForcefieldArgs): Promise<void> {
  try {
    if (process.env.FORCEFIELD_WEB !== "on") return;
    const token = process.env.SITE_ANALYTICS_INGEST_TOKEN;
    const ingestUrl = process.env.FORCEFIELD_INGEST_URL;
    if (!token || !ingestUrl) return;

    const ruleset = await fetchRuleset(process.env.FORCEFIELD_RULESET_URL ?? "");
    const input = observeInputFor(args);
    let obs = observeRequest(input, ruleset);
    if (process.env.FORCEFIELD_ENFORCE === "on" && !args.skipEnforcement) {
      const d = decide(input, ruleset);
      obs = withEnforcement(obs, input, ruleset, { wouldBlock: d.block, blocked: d.block, reasonKind: d.reasonKind, attack: d.attack });
    }
    if (!obs) return;

    const country = input.country;
    await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": token },
      body: JSON.stringify({ type: obs.type, path: obs.path, country: country || undefined, props: obs.props }),
    }).catch(() => {});
  } catch {
    /* Forcefield must never affect the request. */
  }
}

/**
 * ENFORCEMENT guard - the synchronous block decision the middleware acts on.
 *
 * Returns a decision to TURN THE REQUEST AWAY, or null to let it through. It is a
 * no-op (null) unless BOTH FORCEFIELD_WEB and FORCEFIELD_ENFORCE are "on", so
 * enforcement is a second, explicit opt-in on top of monitoring - a site watches
 * first, then graduates. FAIL-OPEN: any error, or a ruleset that won't load,
 * returns null (allow), so enforcement can never itself break the site. The
 * caller (middleware) builds the 403 response and still reports the block.
 */
export async function forcefieldGuard(args: ForcefieldArgs): Promise<EnforcementDecision | null> {
  try {
    if (process.env.FORCEFIELD_WEB !== "on" || process.env.FORCEFIELD_ENFORCE !== "on") return null;
    const ruleset = await fetchRuleset(process.env.FORCEFIELD_RULESET_URL ?? "");
    const decision = decide(observeInputFor(args), ruleset);
    return decision.block ? decision : null;
  } catch {
    return null; // fail-open: enforcement must never break the site.
  }
}
