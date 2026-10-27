/**
 * Forcefield Edge - one request, end to end.
 *
 *   1. Resolve the tenant for the Host header (cached apex lookup). Unknown
 *      hostname -> 421 (this hostname is not served here). Lookup unavailable
 *      and nothing cached -> 502.
 *   2. Refuse what cannot be forwarded safely: a declared body over the platform
 *      limit (413), an origin that is this very hostname (508).
 *   3. Run the vendored engine (decideEdgeRequest): bounded body inspection
 *      (PHP2Shell / React2Shell), payload / header / decoy / tool / blocked
 *      fingerprint rules, and the session intent score.
 *   4. Report the observation to apex (waitUntil, never blocks the response).
 *   5. block -> 403, decoy -> 404, tarpit -> delay then forward, allow -> forward:
 *      an external rewrite to the tenant's origin that keeps method, headers and
 *      body, adds x-forcefield-edge, and strips any copy the visitor sent.
 *
 * Fail-open where it is safe: once the tenant is known, any engine error
 * forwards the request (Forcefield must never take a client's site down).
 */
import { NextResponse } from "next/server";
import { fetchRuleset } from "./forcefield-web/ruleset";
import { IntentLedger } from "./forcefield-web/intent";
import { isSyntheticMonitor } from "./forcefield-web/monitor";
import {
  normalizeEdgeHost,
  originTarget,
  forwardRequestHeaders,
  declaredBodyLength,
  isForwardLoop,
  decideEdgeRequest,
  edgeBlockResponse,
  edgeDecoyResponse,
  EDGE_MAX_BODY_BYTES,
  type EdgeSite,
  type RequestSignals,
} from "./forcefield-web/gateway";
import { lookupEdgeSite } from "./site-cache";
import { reportEdgeEvents } from "./report";

/** The env the edge reads. All optional at the type level; missing site lookup
 *  config makes every request a 502 (misconfigured, never an open proxy). */
export interface EdgeEnv {
  FORCEFIELD_EDGE_SITE_URL?: string;
  FORCEFIELD_EDGE_SERVICE_TOKEN?: string;
  FORCEFIELD_INGEST_URL?: string;
  FORCEFIELD_RULESET_URL?: string;
  /** "on" => blocking allowed (still per tenant: the tenant's enforce flag). */
  FORCEFIELD_ENFORCE?: string;
  /** "on" => intent tarpit / sticky block applied (on top of enforce). */
  FORCEFIELD_INTENT_ENFORCE?: string;
  /** Local proof only: "1" accepts http:// origins. */
  FORCEFIELD_EDGE_ALLOW_HTTP_ORIGIN?: string;
  [key: string]: string | undefined;
}

const ledger = new IntentLedger();

/** Test-only. */
export function _resetEdgeLedger(): void {
  ledger.clear();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** Client IP: Vercel overwrites x-forwarded-for and sets x-vercel-forwarded-for
 *  and x-real-ip itself, so a visitor cannot forge them on Vercel. Used for
 *  crawler verification and the intent session key only; never stored. */
function clientIp(headers: Headers): string {
  const raw = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for") ?? "";
  return raw.split(",")[0].trim();
}

export function edgeSignals(request: Request, nowMs: number): RequestSignals {
  const synthetic = isSyntheticMonitor(request.headers);
  return {
    url: new URL(request.url),
    method: request.method,
    userAgent: request.headers.get("user-agent") ?? "",
    country: request.headers.get("x-vercel-ip-country") ?? "",
    ip: clientIp(request.headers),
    accept: request.headers.get("accept") ?? "",
    secFetchDest: request.headers.get("sec-fetch-dest") ?? "",
    // Edge cannot verify a tenant's own sessions; only our own verified monitor
    // counts as authenticated (it proved itself with the synthetic token).
    authenticated: synthetic,
    ...(synthetic ? { synthetic: true } : {}),
    headerNames: Array.from(request.headers.keys()).map((h) => h.toLowerCase()),
    nowMs,
  };
}

/** The forward: an external rewrite carrying the visitor's method and body, the
 *  rewritten header set, and nothing Edge was told to strip. */
export function forwardTo(request: Request, site: EdgeSite, publicHost: string): NextResponse {
  const proto = request.headers.get("x-forwarded-proto") === "http" ? "http" : "https";
  return NextResponse.rewrite(originTarget(site, request.url), {
    request: { headers: forwardRequestHeaders(request.headers, site, publicHost, proto) },
  });
}

export async function handleEdgeRequest(
  request: Request,
  env: EdgeEnv,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<Response> {
  const host = normalizeEdgeHost(request.headers.get("host"));
  if (!host) return plain(400, "Bad Request: missing or invalid Host header.");

  const lookup = await lookupEdgeSite(host, {
    siteUrl: env.FORCEFIELD_EDGE_SITE_URL ?? "",
    serviceToken: env.FORCEFIELD_EDGE_SERVICE_TOKEN ?? "",
    allowHttpOrigin: env.FORCEFIELD_EDGE_ALLOW_HTTP_ORIGIN === "1",
    fetchImpl: opts.fetchImpl,
    nowMs: opts.nowMs,
  });
  if (!lookup.ok) return plain(502, "Forcefield Edge: site configuration is unavailable. Try again shortly.");
  const site = lookup.site;
  if (!site) return plain(421, "Misdirected Request: this hostname is not served by Forcefield Edge.");

  const declared = declaredBodyLength(request.headers);
  if (declared !== null && declared > EDGE_MAX_BODY_BYTES) {
    return plain(413, `Payload Too Large: Forcefield Edge forwards request bodies up to ${EDGE_MAX_BODY_BYTES} bytes.`);
  }
  if (isForwardLoop(site, host)) return plain(508, "Loop Detected: the origin for this hostname is the hostname itself.");

  try {
    const nowMs = (opts.nowMs ?? Date.now)();
    const ruleset = await fetchRuleset(env.FORCEFIELD_RULESET_URL ?? "", opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
    const signals = edgeSignals(request, nowMs);
    const decision = await decideEdgeRequest({
      request,
      site,
      signals,
      ruleset,
      enforce: env.FORCEFIELD_ENFORCE === "on" && site.enforce,
      intentEnforce: env.FORCEFIELD_INTENT_ENFORCE === "on",
      ledger,
    });

    if (decision.observation || decision.intent?.report) {
      waitUntil(
        reportEdgeEvents(
          { ingestUrl: env.FORCEFIELD_INGEST_URL ?? "", serviceToken: env.FORCEFIELD_EDGE_SERVICE_TOKEN ?? "", fetchImpl: opts.fetchImpl },
          site.tenantId,
          signals.country,
          decision.observation,
          decision.intent,
          signals.url.pathname,
        ),
      );
    }

    if (decision.action === "block") return edgeBlockResponse(decision.verdict.reasonKind);
    if (decision.action === "decoy") return edgeDecoyResponse();
    if (decision.action === "tarpit") await sleep(decision.delayMs);
  } catch {
    /* fail-open: the tenant is known, so forward */
  }
  return forwardTo(request, site, host);
}
