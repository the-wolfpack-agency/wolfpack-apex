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
import { observeRequest } from "./observe";
import { fetchRuleset } from "./ruleset";

/** The subset of a NextRequest this needs - structural, so a NextRequest fits
 *  without importing framework types (keeps the module edge- and test-friendly). */
export interface MonitorRequestLike {
  method: string;
  headers: Headers;
  nextUrl: { pathname: string };
}

/**
 * Classify one request and forward the observation to the analytics ingest.
 * Returns a promise the caller should hand to event.waitUntil so the forward
 * survives the response. Never throws; a no-op unless fully configured + enabled.
 */
export async function forcefieldMonitor(args: { site: string; req: MonitorRequestLike }): Promise<void> {
  try {
    if (process.env.FORCEFIELD_WEB !== "on") return;
    const token = process.env.SITE_ANALYTICS_INGEST_TOKEN;
    const ingestUrl = process.env.FORCEFIELD_INGEST_URL;
    if (!token || !ingestUrl) return;

    const { req } = args;
    const country = req.headers.get("x-vercel-ip-country") ?? "";
    const ruleset = await fetchRuleset(process.env.FORCEFIELD_RULESET_URL ?? "");
    const obs = observeRequest(
      {
        site: args.site,
        path: req.nextUrl.pathname,
        method: req.method,
        userAgent: req.headers.get("user-agent") ?? "",
        country,
        headerNames: Array.from(req.headers.keys()),
        accept: req.headers.get("accept") ?? "",
        secFetchDest: req.headers.get("sec-fetch-dest") ?? "",
        nowMs: Date.now(),
      },
      ruleset,
    );
    if (!obs) return;

    await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": token },
      body: JSON.stringify({ type: obs.type, path: obs.path, country: country || undefined, props: obs.props }),
    }).catch(() => {});
  } catch {
    /* Forcefield must never affect the request. */
  }
}
