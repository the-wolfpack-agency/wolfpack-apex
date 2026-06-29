/**
 * internalFetch - the ONE shared helper for server-side HTTP self-calls to
 * the app's own deployment (one API route calling another so it inherits that
 * route's auth + capability checks).
 *
 * WHY THIS EXISTS (the prod bug it fixes)
 * --------------------------------------
 * Agent on-behalf execution was failing with "On-behalf execution failed:
 * fetch failed". Root cause: a server function calling the app's OWN deployment
 * URL on Vercel hits Vercel Deployment Protection (the per-deployment / preview
 * URL is team-auth-gated and 401s, or the resolved origin is briefly
 * unreachable). undici then throws the opaque "fetch failed", which the
 * executor surfaced verbatim. This broke the flagship "give this agent a job"
 * feature for every non-CRM form kind (the CRM kind has no HTTP hop).
 *
 * Three call sites previously each did a raw `fetch(`${origin}${path}`)`:
 *   - forwardJson() in src/lib/assistant/forms/execute.ts
 *   - the inline chat-list GET in src/lib/assistant/forms/execute.ts
 *   - the operation self-call in src/lib/agents/tasks/executor.ts
 * Routing all three through this one helper (DRY) means the bypass header, the
 * transient-throw retry, and the diagnosable error message are applied
 * uniformly - fix it once, fixed everywhere.
 *
 * WHY A HELPER instead of patching each site (options considered):
 *   1. Patch each fetch() in place. Rejected: three copies of the bypass-header
 *      + retry + diagnostic logic drift apart over time; violates DRY and a new
 *      self-call site would silently miss the fix.
 *   2. A Vercel rewrite / edge config to strip protection. Rejected: changes
 *      infra surface, affects ALL traffic (not just internal self-calls), and
 *      the documented Vercel mechanism for a function calling a protected
 *      deployment is exactly the bypass header below - scoped to the request.
 *   3. This shared helper (chosen): lowest-risk, transport-only change. Each
 *      caller keeps its EXACT status/auth/scope/JSON translation; only the
 *      `fetch` underneath changes.
 *
 * SECURITY (unchanged from the call sites' existing model)
 * -------------------------------------------------------
 * The absolute URL is built from {@link resolveInternalOrigin} - a TRUSTED
 * server-configured origin, NEVER the incoming request's Host (which is
 * attacker-controlled; trusting it with a forwarded bearer is CWE-918
 * request-forgery / token exfiltration). The caller's Authorization header is
 * forwarded VERBATIM and is NEVER logged. We never mint, parse, or inspect
 * tokens here.
 */

import { resolveInternalOrigin } from "@/lib/qr/origin";

/** Injectable fetch so callers (and tests) can stub the transport. Defaults
 *  to the global fetch. */
export type FetchImpl = typeof fetch;

export interface InternalFetchOptions {
  /**
   * Standard fetch init (method, headers, body). Headers are forwarded
   * verbatim and merged with the deployment-protection bypass headers when the
   * bypass secret is configured. Never log the headers - they may carry a
   * bearer token.
   */
  init?: RequestInit;
  /**
   * Override the resolved origin. Absent (the normal path) ->
   * resolveInternalOrigin() is used. Tests pass a fixed origin so they do not
   * depend on env. Production code should NOT pass a request-derived origin
   * (see the security note above).
   */
  originOverride?: string;
  /** Injectable fetch transport. Defaults to the global fetch. */
  fetchImpl?: FetchImpl;
}

/**
 * Vercel Deployment Protection bypass.
 *
 * When `VERCEL_AUTOMATION_BYPASS_SECRET` is set, a request carrying this header
 * is allowed through protection even on a gated deployment URL. This is the
 * documented fix for a serverless function self-calling a protected deployment.
 * `x-vercel-set-bypass-cookie: true` asks Vercel to also set the bypass cookie
 * on the response so a redirect chain stays authorized.
 *
 * OPERATOR STEP: VERCEL_AUTOMATION_BYPASS_SECRET must be set in the Vercel
 * project env for the bypass path to engage. Absent the secret, this returns an
 * empty object and behavior is UNCHANGED (no headers added) - so local dev and
 * non-Vercel runtimes are unaffected.
 */
function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return {};
  return {
    "x-vercel-protection-bypass": secret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

/**
 * Merge the caller's headers (verbatim) with the bypass headers into a PLAIN
 * object. The caller's headers win on conflict - we never override an explicit
 * caller header.
 *
 * We deliberately return a plain Record rather than a Headers instance so the
 * shape the transport receives is identical to the raw `fetch(url, { headers:
 * {...} })` each call site used before (callers and their tests inspect
 * `init.headers.Authorization` directly). This keeps the change transport-only.
 */
function mergeHeaders(
  callerHeaders: HeadersInit | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Normalize whatever the caller passed (plain object, array of tuples, or a
  // Headers instance) into a plain record without losing any entry. We copy
  // keys with their ORIGINAL casing (HTTP headers are case-insensitive on the
  // wire, but call sites pass plain objects with `Authorization`/`Content-Type`
  // and inspect them by that exact key, so we preserve it rather than route
  // through Headers - which would lowercase every key).
  if (callerHeaders instanceof Headers) {
    callerHeaders.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(callerHeaders)) {
    for (const [key, value] of callerHeaders) out[key] = value;
  } else if (callerHeaders) {
    Object.assign(out, callerHeaders as Record<string, string>);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** A tiny backoff so a single transient retry is not an instant hammer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a server-side self-call to an internal API route.
 *
 * Behavior:
 *   - Builds the absolute URL as `<resolveInternalOrigin()><path>` (or the
 *     originOverride). `path` MUST start with "/".
 *   - Adds the Vercel deployment-protection bypass headers when the secret is
 *     set; forwards the caller's headers (incl. Authorization) verbatim.
 *   - Retries ONCE on a THROWN fetch error (undici "fetch failed" is often a
 *     transient resolve/connect blip), with a tiny backoff. A non-2xx response
 *     is a REAL answer from the route and is returned as-is - NEVER retried.
 *   - On a final throw, raises a DIAGNOSABLE error naming the resolved origin +
 *     path and the underlying cause, so any residual failure is pinpointable
 *     instead of the opaque "fetch failed".
 *
 * Returns the raw Response so each caller keeps its existing status / JSON /
 * error translation exactly as before. This helper changes the TRANSPORT only.
 */
export async function internalFetch(
  path: string,
  options: InternalFetchOptions = {},
): Promise<Response> {
  const { init, originOverride, fetchImpl = fetch } = options;
  const origin = (originOverride ?? resolveInternalOrigin()).replace(/\/+$/, "");
  const url = `${origin}${path}`;

  const mergedInit: RequestInit = {
    ...init,
    headers: mergeHeaders(init?.headers, bypassHeaders()),
  };

  // One retry on a THROWN error only. A non-2xx Response is a real answer and
  // is returned without retry. We retry at most once: a persistent failure
  // (e.g. protection still gating because the bypass secret is unset) should
  // surface a diagnosable error fast, not loop.
  const MAX_ATTEMPTS = 2;
  const RETRY_BACKOFF_MS = 150;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchImpl(url, mergedInit);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
    }
  }

  // Final throw: name the origin + path + cause so the failure is pinpointable.
  // Never "fetch failed" with no context. We do NOT include headers (bearer).
  const cause = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Failed to reach internal API at ${url}: ${cause}`);
}
