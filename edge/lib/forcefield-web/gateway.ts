/**
 * Forcefield - the GATEWAY core: the shared logic of every adapter that sits IN
 * FRONT of an origin and proxies to it (the Cloudflare Worker, Forcefield Edge on
 * Vercel). One engine, many runtimes: the per-runtime file only extracts the
 * platform's signals (client IP header, geo header) and performs the forward;
 * everything that decides is here, so the two proxies can never drift in what
 * they detect.
 *
 * Portable (vendored): imports only sibling core files and edge-safe globals
 * (Request, Headers, URL, setTimeout). No Node APIs, no framework types.
 *
 * What lives here:
 *   - RequestSignals + evaluateRequest + shouldBlock: the pure verdict and the
 *     observation for one request (moved from the Worker adapter unchanged).
 *   - inspectBodyBounded: the bounded, clone-based body read that feeds the
 *     PHP2Shell / React2Shell analyzer (body-inspect.ts). Moved from the Worker.
 *   - The Forcefield Edge contract: the per-tenant x-forcefield-edge header, the
 *     site record the edge resolves per hostname, the forwarded header set, and
 *     decideEdgeRequest (block / decoy / tarpit / allow).
 */
import { observeRequest, withEnforcement, type Observation, type ObserveInput } from "./observe";
import { decideEnforcement, type EnforcementDecision, type EnforceInput } from "./enforce";
import { operatorFingerprint } from "./fingerprint";
import { inspectRequestBody, bodyInspectionApplies, BODY_SCAN_CAP_BYTES } from "./body-inspect";
import { evaluateRequestIntent, type RequestIntent } from "./monitor";
import type { IntentLedger } from "./intent";
import type { ForcefieldRuleset } from "./ruleset";

/* ------------------------------------------------------------------------- */
/* Shared proxy verdict (Worker + Edge)                                       */
/* ------------------------------------------------------------------------- */

/** Request signals the engine needs, pulled from a standard Request by the
 *  runtime adapter (each runtime knows which client-IP header it can trust). */
export interface RequestSignals {
  url: URL;
  method: string;
  userAgent: string;
  country: string;
  ip: string;
  accept: string;
  secFetchDest: string;
  /** Client network ASN, when the runtime provides it. */
  asn?: number;
  /** Client network operator name, when the runtime provides it. */
  asOrg?: string;
  /** Site-attested sign-in, or a verified synthetic monitor. */
  authenticated: boolean;
  /** Verified synthetic monitor (x-forcefield-synthetic matched). */
  synthetic?: boolean;
  headerNames: string[];
  nowMs: number;
}

/** PURE: should this request be turned away? Only when the engine proved it
 *  hostile, enforcement is on, AND the site did not attest a signed-in user. */
export function shouldBlock(verdict: EnforcementDecision, s: RequestSignals, enforce: boolean): boolean {
  return verdict.block === true && enforce && !s.authenticated;
}

export interface EvaluateOptions {
  platform?: string;
  bodyAttack?: string;
  /** Admin-blocked operator fingerprints (ruleset.blockedFingerprints). Absent ->
   *  the fingerprint rule never fires (the Worker's behavior). */
  blockedFingerprints?: readonly string[];
}

/** The ObserveInput for a request, built once so the recorded event, the block
 *  decision and the intent score all see the same request. */
export function observeInputFromSignals(site: string, s: RequestSignals, opts: EvaluateOptions = {}): ObserveInput & { asn?: number; asOrg?: string } {
  return {
    site,
    path: s.url.pathname,
    rawUrl: s.url.pathname + s.url.search,
    method: s.method,
    userAgent: s.userAgent,
    country: s.country,
    headerNames: s.headerNames,
    accept: s.accept,
    secFetchDest: s.secFetchDest,
    ip: s.ip || undefined,
    authenticated: s.authenticated,
    ...(s.synthetic ? { synthetic: true } : {}),
    platform: opts.platform,
    bodyAttack: opts.bodyAttack,
    asn: s.asn,
    asOrg: s.asOrg,
    nowMs: s.nowMs,
  };
}

/**
 * PURE: given a site label, request signals, and the ruleset, compute the block
 * verdict and the observation to forward. No I/O, deterministic. Mirrors exactly
 * what monitor.ts does for Next, so the runtimes can never diverge in what they
 * detect.
 */
export function evaluateRequest(
  site: string,
  s: RequestSignals,
  ruleset: ForcefieldRuleset,
  opts: EvaluateOptions = {},
): { verdict: EnforcementDecision; observation: Observation | null } {
  const fingerprint = operatorFingerprint(s.headerNames);
  // authenticated + platform ride along so an engine that reads them honors them;
  // the never-block-a-signed-in-user guarantee itself is enforced in shouldBlock.
  const enforceInput: EnforceInput & { platform?: string } = {
    path: s.url.pathname,
    rawUrl: s.url.pathname + s.url.search,
    method: s.method,
    userAgent: s.userAgent,
    headerNames: s.headerNames,
    fingerprint,
    authenticated: s.authenticated,
    ip: s.ip || undefined,
    platform: opts.platform,
    bodyAttack: opts.bodyAttack,
  };
  const verdict = decideEnforcement(
    enforceInput,
    ruleset,
    opts.blockedFingerprints ? { blockedFingerprints: opts.blockedFingerprints } : {},
  );
  const observation = observeRequest(observeInputFromSignals(site, s, opts), ruleset);
  return { verdict, observation };
}

/**
 * Read AT MOST BODY_SCAN_CAP_BYTES of the request body for inspection, without
 * disturbing the body that reaches the origin. A `request.clone()` gives an
 * independent body stream; we read the first chunks up to the cap, then CANCEL
 * the clone, so memory stays bounded by the cap even for a trickled multi-MB or
 * never-finishing body. The ORIGINAL request is forwarded untouched, so every
 * legitimate upload still reaches the origin whole.
 *
 * Decoded latin1 (byte == code point) so raw null / control bytes survive and
 * the ASCII markers the analyzer looks for still match. Returns the attack label
 * or null; never throws (fail-open: a read error inspects nothing).
 */
export async function inspectBodyBounded(request: Request): Promise<string | null> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const hasNextAction = request.headers.has("next-action") || request.headers.has("rsc-action-id");
    if (!bodyInspectionApplies(request.method, contentType, hasNextAction)) return null;
    if (!request.body) return null;

    const reader = request.clone().body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (total < BODY_SCAN_CAP_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      // If more is left, we stopped at the cap: mark truncated and stop reading.
      if (total >= BODY_SCAN_CAP_BYTES) truncated = true;
    } finally {
      // Fire the cancel, NEVER await it. A clone is one branch of a tee, and
      // cancelling one branch only settles once the other branch (the body that
      // is forwarded to the origin) has been consumed. Awaiting it here deadlocked
      // every body larger than the cap: the forward cannot start until this
      // function returns, so the cancel never settled (a 3 MB POST hung forever
      // under `next start`). The returned promise is caught so it never surfaces
      // as an unhandled rejection.
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* cancelling the inspection clone never affects the forwarded body */
      }
    }

    // Concatenate up to the cap and decode latin1 (binary-safe, 1 byte -> 1 char).
    let body = "";
    let used = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, BODY_SCAN_CAP_BYTES - used);
      for (let i = 0; i < take; i++) body += String.fromCharCode(c[i]);
      used += take;
      if (used >= BODY_SCAN_CAP_BYTES) break;
    }

    const declared = Number(request.headers.get("content-length") ?? "");
    const result = inspectRequestBody({
      method: request.method,
      contentType,
      declaredLength: Number.isFinite(declared) ? declared : undefined,
      body,
      truncated,
    });
    return result ? result.attack : null;
  } catch {
    return null; // fail-open: Forcefield never breaks the request over inspection.
  }
}

/* ------------------------------------------------------------------------- */
/* Forcefield Edge contract                                                   */
/* ------------------------------------------------------------------------- */

/** The header every request Forcefield Edge forwards carries. Its value is the
 *  tenant's own origin secret, so the client's server can accept ONLY traffic
 *  that came through Edge (compare in constant time, reject anything else). Any
 *  copy a visitor sends is removed before the forward, so it cannot be forged
 *  through Edge, and a direct-to-origin request never has the right value. */
export const EDGE_ORIGIN_HEADER = "x-forcefield-edge";

/** Edge -> apex ingest only: the tenant an Edge observation belongs to. Accepted
 *  by the ingest ONLY together with the Edge service token. Never forwarded to an
 *  origin (stripped like the origin header). */
export const EDGE_TENANT_HEADER = "x-forcefield-edge-tenant";

/** Headers removed from the visitor's request before it is forwarded: the two
 *  Edge contract headers (so they cannot be forged) and the synthetic-monitor
 *  secret (compared at the edge, never passed on). */
export const EDGE_STRIPPED_INBOUND = [EDGE_ORIGIN_HEADER, EDGE_TENANT_HEADER, "x-forcefield-synthetic"] as const;

/** Largest request body Edge forwards. Vercel Routing Middleware accepts at most
 *  4 MB of request body (vercel.com/docs/routing-middleware, "Limits on
 *  requests"); a declared length above it gets an explicit 413 from Edge rather
 *  than a platform error or a silently truncated body. */
export const EDGE_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** What Edge needs to serve one hostname, as the apex site endpoint returns it. */
export interface EdgeSite {
  tenantId: string;
  /** The tenant's site label: every event is attributed to it. */
  siteLabel: string;
  /** The client's own server, scheme + host (+ optional port), no path. */
  originUrl: string;
  /** The per-tenant value sent as x-forcefield-edge. */
  originSecret: string;
  /** Blocking is allowed for this tenant (console toggle AND license). */
  enforce: boolean;
  platform?: string;
  stack?: string[];
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize a Host header to a bare lowercase hostname: port and a trailing dot
 *  removed. Returns null for anything that is not a plausible DNS name (an IP
 *  literal with brackets, an empty value, junk), so lookups never see it. */
export function normalizeEdgeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase();
  if (!h || h.startsWith("[")) return null;
  const colon = h.lastIndexOf(":");
  if (colon !== -1) {
    const port = h.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return null;
    h = h.slice(0, colon);
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  return HOST_RE.test(h) ? h : null;
}

/** Validate an origin URL for forwarding: https (http only when explicitly
 *  allowed, for a local proof), no credentials, no path beyond "/", no query or
 *  fragment. Returns the canonical origin ("https://host[:port]") or null. */
export function canonicalOrigin(raw: unknown, opts: { allowHttp?: boolean } = {}): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(opts.allowHttp === true && u.protocol === "http:")) return null;
  if (u.username || u.password) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

/** Coerce the apex site endpoint's JSON into an EdgeSite, or null. Strict: a
 *  record missing any required field is refused rather than half-trusted. */
export function coerceEdgeSite(raw: unknown, opts: { allowHttp?: boolean } = {}): EdgeSite | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const tenantId = str(r.tenantId);
  const siteLabel = str(r.siteLabel);
  const originSecret = str(r.originSecret);
  const originUrl = canonicalOrigin(r.originUrl, opts);
  if (!tenantId || !siteLabel || !originSecret || !originUrl) return null;
  if (originSecret.length < 32) return null;
  const site: EdgeSite = { tenantId, siteLabel, originUrl, originSecret, enforce: r.enforce === true };
  const platform = str(r.platform);
  if (platform) site.platform = platform;
  if (Array.isArray(r.stack)) {
    const stack = r.stack.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 40).slice(0, 8);
    if (stack.length) site.stack = stack;
  }
  return site;
}

/** The URL the request is forwarded to: the origin plus the visitor's path and
 *  query, unchanged. */
export function originTarget(site: Pick<EdgeSite, "originUrl">, requestUrl: string): URL {
  const incoming = new URL(requestUrl);
  return new URL(incoming.pathname + incoming.search, site.originUrl);
}

/** True when forwarding would send the request back to Edge itself (the origin
 *  is the very hostname being served): refused instead of looping. */
export function isForwardLoop(site: Pick<EdgeSite, "originUrl">, publicHost: string): boolean {
  try {
    return new URL(site.originUrl).hostname === publicHost;
  } catch {
    return true;
  }
}

/**
 * The request headers sent to the origin: the visitor's own headers, minus the
 * stripped contract headers, plus x-forcefield-edge (the tenant's secret) and
 * x-forwarded-host / x-forwarded-proto naming the public hostname the visitor
 * used (the origin sees its own hostname in Host, so an app that builds absolute
 * URLs reads the public name from x-forwarded-host, trusting it only when
 * x-forcefield-edge matched).
 */
export function forwardRequestHeaders(incoming: Headers, site: Pick<EdgeSite, "originSecret">, publicHost: string, proto = "https"): Headers {
  const h = new Headers(incoming);
  for (const name of EDGE_STRIPPED_INBOUND) h.delete(name);
  h.set(EDGE_ORIGIN_HEADER, site.originSecret);
  h.set("x-forwarded-host", publicHost);
  h.set("x-forwarded-proto", proto === "http" ? "http" : "https");
  return h;
}

/** The declared body length, or null when the request did not declare one. */
export function declaredBodyLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null || !/^[0-9]{1,15}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export type EdgeAction = "allow" | "block" | "decoy" | "tarpit";

export interface EdgeDecision {
  /** allow -> forward; tarpit -> forward after delayMs; block -> 403; decoy -> 404. */
  action: EdgeAction;
  delayMs: number;
  verdict: EnforcementDecision;
  /** The observation to report (stamped blocked / would_block), or null. */
  observation: Observation | null;
  /** The intent step-up to report, when this request stepped the session up. */
  intent: RequestIntent | null;
  bodyAttack?: string;
}

/**
 * Decide one Edge request: bounded body inspection, the shared verdict, the
 * session intent score, then the action under the tenant's posture. Watch-first:
 * with `enforce` false nothing is ever turned away or slowed; the decision is
 * still computed and the observation stamped would_block so the board shows what
 * Edge WOULD have stopped. Never throws (any surprise -> allow, observation null).
 */
export async function decideEdgeRequest(args: {
  request: Request;
  site: EdgeSite;
  signals: RequestSignals;
  ruleset: ForcefieldRuleset;
  /** Global switch AND the tenant's own enforce flag, resolved by the caller. */
  enforce: boolean;
  /** Intent tarpit / sticky block applied (on top of enforce). */
  intentEnforce: boolean;
  ledger: IntentLedger;
}): Promise<EdgeDecision> {
  const allow: EdgeDecision = { action: "allow", delayMs: 0, verdict: { block: false, reason: "edge error" }, observation: null, intent: null };
  try {
    const { request, site, signals: s, ruleset } = args;
    const bodyAttack = (await inspectBodyBounded(request)) ?? undefined;
    const opts: EvaluateOptions = { platform: site.platform, bodyAttack, blockedFingerprints: ruleset.blockedFingerprints };
    const { verdict, observation: raw } = evaluateRequest(site.siteLabel, s, ruleset, opts);
    const input = observeInputFromSignals(site.siteLabel, s, opts);

    const intent = evaluateRequestIntent(input, ruleset, {
      ledger: args.ledger,
      obs: raw,
      enforcement: verdict,
      posture: args.enforce && args.intentEnforce ? "enforce" : "watch",
      stack: site.stack,
    });

    let action: EdgeAction = "allow";
    let delayMs = 0;
    let effective = verdict;
    if (shouldBlock(verdict, s, args.enforce)) {
      action = verdict.reasonKind === "decoy" ? "decoy" : "block";
    } else if (!verdict.block && intent?.decision.applied && !s.authenticated) {
      if (intent.decision.action === "block") {
        action = "block";
        effective = { block: true, reasonKind: "intent", reason: intent.decision.summary };
      } else if (intent.decision.action === "tarpit" && intent.decision.delayMs > 0) {
        action = "tarpit";
        delayMs = intent.decision.delayMs;
      }
    }

    const wouldBlock = effective.block === true && !s.authenticated;
    const observation = withEnforcement(raw, input, ruleset, {
      wouldBlock,
      blocked: action === "block" || action === "decoy",
      reasonKind: effective.reasonKind,
      attack: effective.attack,
    });
    return { action, delayMs, verdict: effective, observation, intent, ...(bodyAttack ? { bodyAttack } : {}) };
  } catch {
    return allow;
  }
}

/** The plain responses Edge answers with itself. Text only, no detail that helps
 *  an attacker tune a payload. */
export function edgeBlockResponse(reasonKind: string | undefined): Response {
  return new Response("Forbidden: this request was flagged as a hostile automated action.", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-forcefield": `blocked:${reasonKind ?? "hostile"}`, "cache-control": "no-store" },
  });
}

/** A trap-path hit gets the 404 the origin would give for a page that does not
 *  exist, so a scraper learns nothing; the hit is still recorded as blocked. */
export function edgeDecoyResponse(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
