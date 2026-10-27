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
import { observeRequest, withEnforcement, clientKeys, isStaticAsset, type ObserveInput, type Observation } from "./observe";
import { fetchRuleset, type ForcefieldRuleset } from "./ruleset";
import { decideEnforcement, type EnforcementDecision, type BlockReasonKind } from "./enforce";
import { headerSignature } from "./fingerprint";
import {
  IntentLedger,
  carriesOver,
  decideIntent,
  intentEventProps,
  intentSessionKey,
  intentSignalsFor,
  resolveStackProfile,
  type IntentDecision,
  type IntentProofKind,
} from "./intent";

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
  /** The site's declared stack (e.g. ["nextjs"]), for intent scoring: a request
   *  for a product or server-side runtime outside it is reconnaissance. Absent
   *  -> the platform is used; neither -> recon scoring is off. */
  stack?: string[];
}

/** The header a VERIFIED synthetic monitor (our own Playwright smoke tests,
 *  canaries, uptime monitors) presents. Its value is compared and discarded:
 *  never logged, never forwarded (only header NAMES ever leave this module). */
export const SYNTHETIC_HEADER = "x-forcefield-synthetic";

/** The header an AI agent presents its signed delegation credential in (Know
 *  the Principal: `<base64url(body)>.<timestamp>.<signature>`). The edge cannot
 *  verify it (it holds no issuer keys), so on a STATE-CHANGING request only it
 *  is forwarded to the ingest, which verifies it fail-closed and stores only
 *  the verdict, never the credential. */
export const DELEGATION_HEADER = "x-forcefield-delegation";
const MAX_DELEGATION_BYTES = 8 * 1024;

/** The delegation credential to forward for an action event, or undefined. */
export function delegationFor(headers: Headers, obs: Observation | null): string | undefined {
  try {
    if (!obs || typeof obs.props.accountability !== "string") return undefined;
    const raw = headers.get(DELEGATION_HEADER) ?? "";
    return raw && raw.length <= MAX_DELEGATION_BYTES ? raw : undefined;
  } catch {
    return undefined;
  }
}

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
  // Our own monitor PROVED itself with the shared token (never the UA). It is
  // authenticated (no weak-tell noise, never fingerprint-blocked) AND stamped
  // synthetic, so its events stay on the board but never raise an alert.
  const synthetic = isSyntheticMonitor(req.headers);
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
    authenticated: args.authenticated === true || synthetic,
    synthetic,
    platform: args.platform,
    nowMs: Date.now(),
  };
}

/* ------------------------------ intent scoring ----------------------------- */

/** One ledger per instance (bounded; IP-free keys), shared by the vendored
 *  guard/monitor and the central observe route. */
const _intentLedger = new IntentLedger();

/** The instance's intent ledger (the central observe route uses it too). */
export function intentLedger(): IntentLedger {
  return _intentLedger;
}

/** Test-only: clear the intent ledger and the per-request memo. */
export function _resetIntentLedger(): void {
  _intentLedger.clear();
}

/** The block reason that counts as PROOF for intent (every enforce rule except
 *  the intent rule itself). */
function proofFor(d: EnforcementDecision): IntentProofKind | undefined {
  if (!d.block) return undefined;
  const k = d.reasonKind;
  return k === "decoy" || k === "payload" || k === "attack_tool" || k === "blocked_fingerprint" ? k : undefined;
}

/** Intent is applied (tarpit / sticky block) only when enforcement is on AND
 *  intent enforcement is explicitly on. Default: record-only (measured, see
 *  the PR): the decision is computed and recorded with applied:false. */
function intentPosture(): "watch" | "enforce" {
  return process.env.FORCEFIELD_ENFORCE === "on" && process.env.FORCEFIELD_INTENT_ENFORCE === "on" ? "enforce" : "watch";
}

export interface RequestIntent {
  decision: IntentDecision;
  /** True when this request stepped the session up (record an event). */
  report: boolean;
  props: Record<string, string | number | boolean>;
}

/**
 * Score one request into its session and decide the step-up. Shared by the
 * vendored guard/monitor and the central observe route so both run identical
 * logic. `ledger` is the caller's (one per instance). Never throws.
 */
export function evaluateRequestIntent(
  input: ObserveInput,
  ruleset: ForcefieldRuleset,
  opts: {
    ledger: IntentLedger;
    obs: Observation | null;
    enforcement: EnforcementDecision;
    posture: "watch" | "enforce";
    stack?: readonly string[];
  },
): RequestIntent | null {
  try {
    const { sig, fp, client } = clientKeys(input, ruleset);
    const profile = resolveStackProfile({ stack: opts.stack, platform: input.platform }, ruleset);
    const welcomed = opts.obs?.type === "site.agent_welcomed";
    const probe = typeof opts.obs?.props.probe === "string" ? (opts.obs.props.probe as string) : null;
    const authenticated = input.authenticated === true || input.synthetic === true;
    const signals = intentSignalsFor(
      { path: input.path, rawUrl: input.rawUrl, clientType: client.clientType, authenticated, welcomed, probe, staticAsset: isStaticAsset(input.path) },
      profile,
      ruleset,
    );
    const { key, scope } = intentSessionKey({ ip: input.ip, userAgent: input.userAgent, headerShape: headerSignature(input.headerNames), sig });
    const carryover = !authenticated && !welcomed && carriesOver(fp, client.clientType, ruleset.intentCarryover, input.nowMs);
    const ownProof = authenticated ? undefined : proofFor(opts.enforcement);
    const intent = opts.ledger.note(key, input.nowMs, {
      path: input.path,
      signals,
      proof: ownProof,
      nonBrowser: !authenticated && !welcomed && client.clientType !== "browser" && !isStaticAsset(input.path),
      carryover,
    });
    const decision = decideIntent(intent, { posture: opts.posture, keyScope: scope, clientType: client.clientType });
    // Record a step-up only when it says something the request's own event does
    // not: real intent signals, or a follow-on request of a proven session. A
    // lone proof request is already recorded (and blocked) by its own event.
    const meaningful = decision.reasons.some((r) => r !== "automation_client") || !ownProof;
    const report = decision.action !== "none" && meaningful && opts.ledger.shouldReport(key, decision.action);
    const props = intentEventProps(decision, { site: input.site, sig, fp, clientType: client.clientType });
    if (input.synthetic === true) props.synthetic = true;
    return { decision, report, props };
  } catch {
    return null;
  }
}

/** Per-request memo so the guard and the monitor (both run for one request)
 *  note it into the ledger ONCE. */
const _intentMemo = new WeakMap<object, RequestIntent | null>();

function intentFor(args: ForcefieldArgs, input: ObserveInput, ruleset: ForcefieldRuleset, d: EnforcementDecision): RequestIntent | null {
  if (_intentMemo.has(args.req)) return _intentMemo.get(args.req) ?? null;
  const obs = observeRequest(input, ruleset);
  const r = evaluateRequestIntent(input, ruleset, { ledger: _intentLedger, obs, enforcement: d, posture: intentPosture(), stack: args.stack });
  _intentMemo.set(args.req, r);
  return r;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    const d = decide(input, ruleset);
    // Intent: control-plane requests (skipEnforcement) are never scored.
    const intent = args.skipEnforcement ? null : intentFor(args, input, ruleset, d);
    const intentBlocked = !d.block && intent?.decision.action === "block" && intent.decision.applied;
    if (process.env.FORCEFIELD_ENFORCE === "on" && !args.skipEnforcement) {
      if (d.block) {
        obs = withEnforcement(obs, input, ruleset, { wouldBlock: true, blocked: true, reasonKind: d.reasonKind, attack: d.attack });
      } else if (intentBlocked) {
        obs = withEnforcement(obs, input, ruleset, { wouldBlock: true, blocked: true, reasonKind: "intent" });
      }
    }

    const country = input.country;
    const send = (type: string, path: string, props: Record<string, string | number | boolean>, delegation?: string) =>
      fetch(ingestUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-token": token },
        body: JSON.stringify({ type, path, country: country || undefined, props, ...(delegation ? { delegation } : {}) }),
      }).catch(() => {});
    if (obs) await send(obs.type, obs.path, obs.props, delegationFor(args.req.headers, obs));
    // One intent event per step-up (watch -> tarpit -> block), with its reasons.
    if (intent?.report) await send("site.intent_scored", input.path, intent.props);
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
    const input = observeInputFor(args);
    const decision = decide(input, ruleset);
    if (decision.block) {
      intentFor(args, input, ruleset, decision); // record the proof into the session
      return decision;
    }
    // INTENT step-up (applied only with FORCEFIELD_INTENT_ENFORCE=on): a proven
    // session's follow-on requests are turned away; a tarpitted session is slowed
    // here, so a host middleware gets the slow-down with no code change.
    const intent = args.skipEnforcement ? null : intentFor(args, input, ruleset, decision);
    if (intent?.decision.applied) {
      if (intent.decision.action === "block") {
        const reasonKind: BlockReasonKind = "intent";
        return { block: true, reasonKind, reason: intent.decision.summary };
      }
      if (intent.decision.action === "tarpit" && intent.decision.delayMs > 0) await sleep(intent.decision.delayMs);
    }
    return null;
  } catch {
    return null; // fail-open: enforcement must never break the site.
  }
}
