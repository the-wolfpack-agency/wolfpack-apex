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
 */
import { observeRequest, type Observation } from "../observe";
import { decideEnforcement, type EnforcementDecision } from "../enforce";
import { fetchRuleset } from "../ruleset";
import { operatorFingerprint } from "../fingerprint";

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

/** Request signals the engine needs, pulled from a standard Request. Pure. */
export interface RequestSignals {
  url: URL;
  method: string;
  userAgent: string;
  country: string;
  ip: string;
  accept: string;
  secFetchDest: string;
  headerNames: string[];
  nowMs: number;
}

/** Extract the engine's input signals from a standard web Request. The header
 *  names are lowercased (the engine's spoof/order checks expect that), and the
 *  client IP + country come from Cloudflare's edge headers (used for hosting
 *  classification only, then discarded - never stored). */
export function requestSignals(request: Request, nowMs: number): RequestSignals {
  const url = new URL(request.url);
  const headerNames = Array.from(request.headers.keys()).map((h) => h.toLowerCase());
  const ipRaw =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for") ??
    "";
  return {
    url,
    method: request.method,
    userAgent: request.headers.get("user-agent") ?? "",
    country: request.headers.get("cf-ipcountry") ?? "",
    ip: ipRaw.split(",")[0].trim(),
    accept: request.headers.get("accept") ?? "",
    secFetchDest: request.headers.get("sec-fetch-dest") ?? "",
    headerNames,
    nowMs,
  };
}

/**
 * PURE: given a site label, request signals, and the ruleset, compute the block
 * verdict and the observation to forward. No I/O, deterministic - the testable
 * heart of the adapter. Mirrors exactly what monitor.ts does for Next, so the two
 * runtimes can never diverge in what they detect.
 */
export function evaluateRequest(
  site: string,
  s: RequestSignals,
  ruleset: Parameters<typeof decideEnforcement>[1],
): { verdict: EnforcementDecision; observation: Observation | null } {
  const fingerprint = operatorFingerprint(s.headerNames);
  const verdict = decideEnforcement(
    {
      path: s.url.pathname,
      rawUrl: s.url.pathname + s.url.search,
      method: s.method,
      userAgent: s.userAgent,
      headerNames: s.headerNames,
      fingerprint,
    },
    ruleset,
  );
  const observation = observeRequest(
    {
      site,
      path: s.url.pathname,
      method: s.method,
      userAgent: s.userAgent,
      country: s.country,
      headerNames: s.headerNames,
      accept: s.accept,
      secFetchDest: s.secFetchDest,
      ip: s.ip || undefined,
      nowMs: s.nowMs,
    },
    ruleset,
  );
  return { verdict, observation };
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
 * Flow per request: classify with the shared engine -> forward the observation
 * (always, monitor-first) -> turn away a proven-hostile request ONLY when
 * FORCEFIELD_ENFORCE is "on" -> otherwise proxy to the origin. The whole body is
 * fail-open: on any error the request still reaches the origin.
 */
export const forcefieldWorker = {
  async fetch(request: Request, env: ForcefieldWorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      if (!env.FORCEFIELD_ORIGIN) {
        // Misconfigured: with no origin there is nothing to protect. Fail loud here
        // (config error, not a request error) rather than silently black-holing.
        return new Response("Forcefield: FORCEFIELD_ORIGIN is not configured.", { status: 500 });
      }
      const ruleset = await fetchRuleset(env.FORCEFIELD_RULESET_URL ?? "");
      const s = requestSignals(request, Date.now());
      const { verdict, observation } = evaluateRequest(env.FORCEFIELD_SITE, s, ruleset);

      if (observation) ctx.waitUntil(forwardObservation(env, observation, s.country));

      if (verdict.block && env.FORCEFIELD_ENFORCE === "on") {
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

export default forcefieldWorker;
