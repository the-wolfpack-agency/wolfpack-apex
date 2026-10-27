/**
 * Forcefield - Cloudflare Worker adapter.
 *
 * Puts Forcefield in front of ANY origin (WordPress, PHP, a static host, a Vercel
 * app - any stack) by running it at Cloudflare's edge, reusing the SAME portable
 * engine the Next.js middleware runs: observeRequest / decideEnforcement /
 * fetchRuleset. ONE engine, MANY runtimes - the only per-runtime code is this thin
 * wrapper that reads the platform's config and proxies the response. It is
 * MONITOR-FIRST (watch before blocking) and FAIL-OPEN (any error, or a ruleset
 * that will not load, lets the request through to the origin): Forcefield can
 * never take a client's site down.
 *
 * Why a Worker is the universal self-serve adapter: the detection core
 * (src/lib/forcefield-web/*) imports only edge-safe globals, so the exact same
 * TypeScript runs unchanged in a Worker. A client routes their domain through
 * Cloudflare and binds the env below - no code in their app, no stack assumption.
 * For a Next.js/Vercel site the in-app middleware (monitor.ts) stays the lighter
 * path; this covers everyone not on a JS server they control.
 *
 * Deploy (self-serve): point the domain at Cloudflare, add this Worker on the
 * route, set the bindings, flip FORCEFIELD_ENFORCE to "on" when ready. The engine
 * updates centrally via FORCEFIELD_RULESET_URL - no Worker redeploy to add a new
 * scanner signature or trap path.
 *
 * A signed-in user is NEVER blocked by this adapter. Sign-in is ATTESTED by the
 * site through the `isAuthenticated` option of createForcefieldWorker (its own
 * session check), never inferred from a cookie or Authorization header being
 * present, which any client can send.
 */
import type { Observation } from "../observe";
import { fetchRuleset } from "../ruleset";
import { resolveAuthenticated } from "../shim";
import { evaluateRequest, shouldBlock, inspectBodyBounded, type RequestSignals } from "../gateway";

// The verdict, the bounded body read and the signal shape are shared with every
// gateway adapter (gateway.ts); re-exported so existing imports keep working.
export { evaluateRequest, shouldBlock, inspectBodyBounded, type RequestSignals };

/** Env bindings the Worker reads. Platform-neutral names (no VERCEL_*), matching
 *  the shim's env so a site can move between adapters without renaming secrets. */
export interface ForcefieldWorkerEnv {
  /** The property label this traffic belongs to (e.g. "beforeutrade"). */
  FORCEFIELD_SITE: string;
  /** Absolute origin to proxy allowed requests to (the client's real server). */
  FORCEFIELD_ORIGIN: string;
  /** "on" => turn away proven-hostile requests. Anything else => monitor-only. */
  FORCEFIELD_ENFORCE?: string;
  /** Central ruleset endpoint. Unset => the engine runs on its bundled defaults. */
  FORCEFIELD_RULESET_URL?: string;
  /** Absolute ingest URL for forwarding observations. Unset => no forward. */
  FORCEFIELD_INGEST_URL?: string;
  /** Shared ingest secret. Unset => no forward. */
  SITE_ANALYTICS_INGEST_TOKEN?: string;
}

/** The minimal slice of a Cloudflare ExecutionContext this uses (typed here so the
 *  adapter needs no @cloudflare/workers-types dependency to compile in-repo). */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Options a site can pass when it builds its Worker (createForcefieldWorker). */
export interface ForcefieldWorkerOptions {
  /** The platform the origin runs (e.g. "wordpress"), so the engine treats that
   *  platform's own paths as the site's, not as recon. Optional. */
  platform?: string;
  /** SITE-ATTESTED sign-in check. Return true ONLY when the site verified a real
   *  signed-in session or service credential for this request (for example by
   *  validating its session cookie against its own key). Never base it on header
   *  presence. A request it returns true for is reported as authenticated and is
   *  never blocked. A throw or rejection means anonymous. Optional; absent means
   *  every request is anonymous. */
  isAuthenticated?: (request: Request, env: ForcefieldWorkerEnv) => boolean | Promise<boolean>;
}

/** The slice of Cloudflare's `request.cf` object this adapter reads. */
interface CfProperties {
  asn?: unknown;
  asOrganization?: unknown;
}

/** Extract the engine's input signals from a standard web Request. The header
 *  names are lowercased (the engine's spoof/order checks expect that). The
 *  client IP comes ONLY from CF-Connecting-IP, which Cloudflare sets itself and a
 *  client cannot override; X-Forwarded-For / X-Real-IP are client-controlled on
 *  the way in, and a forged IP could pose as an allowlisted crawler's range or
 *  hide a datacenter origin, so they are never used. The IP, ASN and network
 *  name are used for network classification only, then discarded, never stored. */
export function requestSignals(request: Request, nowMs: number, opts: { authenticated?: boolean } = {}): RequestSignals {
  const url = new URL(request.url);
  const headerNames = Array.from(request.headers.keys()).map((h) => h.toLowerCase());
  const ipRaw = request.headers.get("cf-connecting-ip") ?? "";
  const cf = (request as Request & { cf?: CfProperties }).cf;
  const signals: RequestSignals = {
    url,
    method: request.method,
    userAgent: request.headers.get("user-agent") ?? "",
    country: request.headers.get("cf-ipcountry") ?? "",
    ip: ipRaw.split(",")[0].trim(),
    accept: request.headers.get("accept") ?? "",
    secFetchDest: request.headers.get("sec-fetch-dest") ?? "",
    authenticated: opts.authenticated === true,
    headerNames,
    nowMs,
  };
  if (cf && typeof cf.asn === "number" && Number.isFinite(cf.asn)) signals.asn = cf.asn;
  if (cf && typeof cf.asOrganization === "string" && cf.asOrganization) signals.asOrg = cf.asOrganization;
  return signals;
}

/** Run the site's sign-in attestation. Only a literal `true` counts; a missing
 *  hook, a throw, a rejection or any other value means anonymous. Never throws. */
export async function workerAuthenticated(
  request: Request,
  env: ForcefieldWorkerEnv,
  opts: ForcefieldWorkerOptions,
): Promise<boolean> {
  const check = opts.isAuthenticated;
  return resolveAuthenticated(request, { isAuthenticated: check ? (r) => check(r, env) : undefined });
}

/** Forward one observation to the analytics ingest. Fire-and-forget, never throws.
 *  Mirrors the monitor.ts body shape so both adapters hit the same ingest contract. */
async function forwardObservation(env: ForcefieldWorkerEnv, obs: Observation, country: string): Promise<void> {
  if (!env.FORCEFIELD_INGEST_URL || !env.SITE_ANALYTICS_INGEST_TOKEN) return;
  try {
    await fetch(env.FORCEFIELD_INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": env.SITE_ANALYTICS_INGEST_TOKEN },
      body: JSON.stringify({ type: obs.type, path: obs.path, country: country || undefined, props: obs.props }),
    });
  } catch {
    /* ingest is best-effort; a down store never affects the request */
  }
}

/** Proxy a request through to the configured origin, preserving method/headers/body. */
function proxyToOrigin(request: Request, env: ForcefieldWorkerEnv): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.FORCEFIELD_ORIGIN);
  return fetch(new Request(target.toString(), request));
}

/**
 * The Worker entrypoint. Export as the module's default from the deployed Worker:
 *
 *   import worker from "@ogiam/forcefield/cloudflare";
 *   export default worker;
 *
 * Or, to declare the origin's platform and attest signed-in users:
 *
 *   import { createForcefieldWorker } from "@ogiam/forcefield/cloudflare";
 *   export default createForcefieldWorker({
 *     platform: "wordpress",
 *     isAuthenticated: (req, env) => verifySessionCookie(req, env), // your own check
 *   });
 *
 * Flow per request: classify with the shared engine -> forward the observation
 * (always, monitor-first) -> turn away a proven-hostile request ONLY when
 * FORCEFIELD_ENFORCE is "on" -> otherwise proxy to the origin. The whole body is
 * fail-open: on any error the request still reaches the origin.
 */
export function createForcefieldWorker(options: ForcefieldWorkerOptions = {}) {
  return {
    async fetch(request: Request, env: ForcefieldWorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
      try {
        if (!env.FORCEFIELD_ORIGIN) {
          // Misconfigured: with no origin there is nothing to protect. Fail loud here
          // (config error, not a request error) rather than silently black-holing.
          return new Response("Forcefield: FORCEFIELD_ORIGIN is not configured.", { status: 500 });
        }
        const ruleset = await fetchRuleset(env.FORCEFIELD_RULESET_URL ?? "");
        const authenticated = await workerAuthenticated(request, env, options);
        const s = requestSignals(request, Date.now(), { authenticated });
        // Bounded body inspection for the two body-borne RCEs (PHP2Shell,
        // React2Shell) the URL/header engine cannot see. Monitor-first: computed
        // whatever the mode, so a watch-mode hit is still recorded; blocking stays
        // gated by shouldBlock below. Reads the clone, never the forwarded body.
        const bodyAttack = (await inspectBodyBounded(request)) ?? undefined;
        const { verdict, observation } = evaluateRequest(env.FORCEFIELD_SITE, s, ruleset, { platform: options.platform, bodyAttack });

        if (observation) ctx.waitUntil(forwardObservation(env, observation, s.country));

        if (shouldBlock(verdict, s, env.FORCEFIELD_ENFORCE === "on")) {
          return new Response("Forbidden: this request was flagged as a hostile automated action.", {
            status: 403,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-forcefield": `blocked:${verdict.reasonKind ?? "hostile"}`,
            },
          });
        }
        return await proxyToOrigin(request, env);
      } catch {
        // FAIL-OPEN: Forcefield must never take the site down. On any failure the
        // request still reaches the origin.
        try {
          return await proxyToOrigin(request, env);
        } catch {
          return new Response("origin unavailable", { status: 502 });
        }
      }
    },
  };
}

/** The default Worker: no platform declared, every request anonymous. */
export const forcefieldWorker = createForcefieldWorker();

export default forcefieldWorker;
