/**
 * The Forcefield edge SHIM - the ONLY Forcefield code a connected site carries.
 *
 * It contains NO classification logic: it extracts raw request signals and ships
 * them to the CENTRAL engine (POST /api/forcefield/observe on apex), which
 * classifies, fingerprints, records, and returns the enforcement decision. So the
 * engine updates in ONE place and every site - one or seven hundred - runs
 * identical logic without a redeploy. This file is stable by design; it changes
 * only if the raw-signal contract changes, which is rare.
 *
 * Edge-safe: standard Request + fetch only, no framework dependency, runs in any
 * middleware. FAIL-OPEN everywhere - a Forcefield hiccup must never break a site.
 *
 * A signed-in user is NEVER blocked by the shim. Whether a request is signed in
 * is ATTESTED by the host site through `isAuthenticated` (its own session check),
 * never inferred from a cookie or Authorization header being present, which any
 * client can send.
 */
export interface ForcefieldShimConfig {
  /** The central engine URL, e.g. https://wolfpack-instinct.vercel.app/api/forcefield/observe */
  endpoint: string;
  /** The per-site edge secret (FORCEFIELD_EDGE_TOKEN). */
  token: string;
  /** This property's name, e.g. "ogiam.com". */
  site: string;
  /** The platform the site runs on (e.g. "wordpress"), so the engine treats that
   *  platform's own paths as the site's, not as recon. Optional. */
  platform?: string;
  /** SITE-ATTESTED sign-in check. Return true ONLY when the site itself verified a
   *  real signed-in session or service credential for this request (for example by
   *  validating its session cookie). Never base it on header presence. A request
   *  it returns true for is reported as authenticated and is never blocked. If it
   *  throws or rejects, the request is treated as anonymous. Optional; absent means
   *  every request is anonymous. */
  isAuthenticated?: (req: Request) => boolean | Promise<boolean>;
}

/** Network facts the edge already knows. All optional; the IP is classified by
 *  the engine and then discarded, never stored. */
export interface ForcefieldEdgeGeo {
  country?: string;
  ip?: string;
  /** Autonomous system number of the client network, when the edge provides it. */
  asn?: number;
  /** Name of that network's operator, when the edge provides it. */
  asOrg?: string;
}

export interface ForcefieldSignals {
  path: string;
  rawUrl: string;
  method: string;
  userAgent: string;
  country: string;
  ip?: string;
  accept?: string;
  secFetchDest?: string;
  asn?: number;
  asOrg?: string;
  /** Site-attested sign-in (see ForcefieldShimConfig.isAuthenticated). */
  authenticated?: boolean;
  platform?: string;
  headerNames: string[];
}

/** Extract the raw signals the central engine needs from a standard Request.
 *  Pure + framework-free so it unit-tests without a browser or a server.
 *
 *  Client IP: pass `geo.ip` from your platform's trusted source whenever you have
 *  one. The X-Forwarded-For fallback is only trustworthy on an edge that
 *  overwrites that header itself (Vercel does); on a server clients can reach
 *  directly, anyone can send it with any value. */
export function signalsFromRequest(req: Request, geo: ForcefieldEdgeGeo = {}): ForcefieldSignals {
  const url = new URL(req.url);
  const fwd = req.headers.get("x-forwarded-for");
  const signals: ForcefieldSignals = {
    path: url.pathname,
    rawUrl: url.pathname + url.search,
    method: req.method,
    userAgent: req.headers.get("user-agent") || "",
    country: geo.country || req.headers.get("x-vercel-ip-country") || "",
    ip: geo.ip || (fwd ? fwd.split(",")[0]?.trim() : undefined),
    accept: req.headers.get("accept") || undefined,
    secFetchDest: req.headers.get("sec-fetch-dest") || undefined,
    headerNames: Array.from(req.headers.keys()),
  };
  if (typeof geo.asn === "number" && Number.isFinite(geo.asn)) signals.asn = geo.asn;
  if (geo.asOrg) signals.asOrg = geo.asOrg;
  return signals;
}

/** Run the host's sign-in attestation. Only a literal `true` counts; a missing
 *  hook, a throw, a rejection or any other value means anonymous. Never throws. */
export async function resolveAuthenticated(req: Request, cfg: Pick<ForcefieldShimConfig, "isAuthenticated">): Promise<boolean> {
  if (!cfg.isAuthenticated) return false;
  try {
    return (await cfg.isAuthenticated(req)) === true;
  } catch {
    return false;
  }
}

/** Ship signals to the central engine and return whether to BLOCK this request.
 *  Fail-open: any error (network, non-200, bad body) returns false (allow), so a
 *  Forcefield outage can never turn away a real visitor. A request marked
 *  authenticated is still reported (so the engine learns from it) but is never
 *  blocked, whatever the engine answers. */
export async function forcefieldDecide(signals: ForcefieldSignals, cfg: ForcefieldShimConfig): Promise<boolean> {
  try {
    const platform = signals.platform ?? cfg.platform;
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-token": cfg.token },
      body: JSON.stringify({ site: cfg.site, ...signals, ...(platform ? { platform } : {}) }),
    });
    if (signals.authenticated === true) return false; // never block a signed-in user
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({ action: "allow" }))) as { action?: string };
    return data?.action === "block";
  } catch {
    return false;
  }
}

/** One call for a host middleware: extract signals, attach the site's sign-in
 *  attestation and platform, ask the engine, return whether to block. Fail-open
 *  and never blocks an authenticated request, exactly like forcefieldDecide. */
export async function forcefieldCheck(req: Request, cfg: ForcefieldShimConfig, geo: ForcefieldEdgeGeo = {}): Promise<boolean> {
  try {
    const signals = signalsFromRequest(req, geo);
    signals.authenticated = await resolveAuthenticated(req, cfg);
    if (cfg.platform) signals.platform = cfg.platform;
    return await forcefieldDecide(signals, cfg);
  } catch {
    return false;
  }
}
