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
 */
export interface ForcefieldShimConfig {
  /** The central engine URL, e.g. https://wolfpack-instinct.vercel.app/api/forcefield/observe */
  endpoint: string;
  /** The per-site edge secret (FORCEFIELD_EDGE_TOKEN). */
  token: string;
  /** This property's name, e.g. "ogiam.com". */
  site: string;
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
  headerNames: string[];
}

/** Extract the raw signals the central engine needs from a standard Request.
 *  Pure + framework-free so it unit-tests without a browser or a server. */
export function signalsFromRequest(req: Request, geo: { country?: string; ip?: string } = {}): ForcefieldSignals {
  const url = new URL(req.url);
  const fwd = req.headers.get("x-forwarded-for");
  return {
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
}

/** Ship signals to the central engine and return whether to BLOCK this request.
 *  Fail-open: any error (network, non-200, bad body) returns false (allow), so a
 *  Forcefield outage can never turn away a real visitor. */
export async function forcefieldDecide(signals: ForcefieldSignals, cfg: ForcefieldShimConfig): Promise<boolean> {
  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-edge-token": cfg.token },
      body: JSON.stringify({ site: cfg.site, ...signals }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({ action: "allow" }))) as { action?: string };
    return data?.action === "block";
  } catch {
    return false;
  }
}
