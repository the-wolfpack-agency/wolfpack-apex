/**
 * Forcefield for the Web - "actions need a person" (accountable actions).
 *
 * Anyone, human or AI agent, may READ a protected site. A STATE-CHANGING action
 * (a form submission, login, sign-up, checkout, account change, data export)
 * should come from an accountable party: a real browser session, or an AI agent
 * that presents a VERIFIED signed delegation naming the person or organization
 * it acts for and what it may do (Know the Principal, src/lib/forcefield/
 * principal.ts). This module decides, per request:
 *
 *   1. Is it state-changing? (stateChangeOf) Pure ruleset data: the methods
 *      that change state and the site's action routes, so a new route or kind
 *      reaches every site through the central ruleset, not a redeploy.
 *   2. Who is accountable for it? (accountabilityVerdict) One of
 *        "browser_session"   a real browser, or a session the site attested
 *        "signed_principal"  an agent with a verified principal (in or out of
 *                            its mandate)
 *        "unaccountable"     automation with no accountable party
 *      and whether the action WOULD HAVE BEEN HELD for review.
 *
 * WATCH MODE ONLY. Nothing here blocks, slows or alters a request: the verdict
 * is recorded on the event (props.accountability and friends, no PII) and
 * counted on the board. The criteria for ever turning on "hold for review" are
 * in docs/forcefield/accountable-actions.md.
 *
 * PURE + EDGE-SAFE: imports nothing, so it is vendored with the core. The edge
 * cannot verify a principal (it never holds issuer keys); the server boundary
 * that does (ingest / observe route) refines the edge verdict with
 * applyPrincipalToAction, so both ends share one rule set.
 */

export type AccountabilityClass = "browser_session" | "signed_principal" | "unaccountable";

export const ACCOUNTABILITY_CLASSES: readonly AccountabilityClass[] = ["browser_session", "signed_principal", "unaccountable"];

/** Why a verdict was reached. A closed vocabulary, so the board and the ingest
 *  can validate it and nothing free-form is ever stored. */
export type AccountabilityReason =
  | "site_attested_session" // the site itself verified a signed-in session / credential
  | "browser_signals" // a real browser: browser UA + header shape + Fetch Metadata
  | "verified_principal" // a verified delegation names the principal and mandate
  | "principal_unverified" // a delegation was presented but did not verify
  | "agent_without_principal" // a known / signed agent, but no principal behind it
  | "browser_from_datacenter" // a browser UA from a cloud / hosting network
  | "no_fetch_metadata" // a browser UA that sent no Sec-Fetch-* headers
  | "header_mismatch" // a browser UA without a browser's headers
  | "headless_browser" // an automated browser
  | "script_client"; // an HTTP library, scanner, or unrecognized automation

export const ACCOUNTABILITY_REASONS: readonly AccountabilityReason[] = [
  "site_attested_session", "browser_signals", "verified_principal", "principal_unverified",
  "agent_without_principal", "browser_from_datacenter", "no_fetch_metadata", "header_mismatch",
  "headless_browser", "script_client",
];

/** One configured action route. `pattern` matches the path exactly or as a
 *  prefix ("/checkout" covers "/checkout/pay"; a pattern ending in "/" is a pure
 *  prefix). `methods` absent = the ruleset's state-changing methods; a route
 *  that changes state on GET (a data export) lists "GET" explicitly. */
export interface ActionRoute {
  pattern: string;
  kind: string;
  methods?: string[];
}

export interface StateChangeRules {
  /** Methods that change state on any non-static, non-ignored path. */
  methods: string[];
  /** Named action routes for every site (login, sign-up, checkout, ...). */
  routes: ActionRoute[];
  /** Extra action routes per site label, checked before the shared ones. */
  siteRoutes?: Record<string, ActionRoute[]>;
  /** Paths that are never an action (telemetry beacons, the Forcefield control
   *  plane). Same prefix rule as `pattern`. */
  ignorePaths: string[];
  /** Record an action the site already ATTESTED (signed-in session) as its own
   *  event even when nothing else is recorded. Off by default: a signed-in app
   *  makes many API writes per page and every one is accountable by definition,
   *  so forwarding each would multiply event volume for no signal. */
  recordAttested?: boolean;
}

/** The bundled defaults, carried in DEFAULT_RULESET and served centrally. */
export const DEFAULT_STATE_CHANGE_RULES: StateChangeRules = {
  methods: ["POST", "PUT", "PATCH", "DELETE"],
  routes: [
    { pattern: "/login", kind: "login" },
    { pattern: "/signin", kind: "login" },
    { pattern: "/sign-in", kind: "login" },
    { pattern: "/wp-login.php", kind: "login" },
    { pattern: "/api/auth/login", kind: "login" },
    { pattern: "/signup", kind: "signup" },
    { pattern: "/sign-up", kind: "signup" },
    { pattern: "/register", kind: "signup" },
    { pattern: "/wp-signup.php", kind: "signup" },
    { pattern: "/api/auth/register", kind: "signup" },
    { pattern: "/checkout", kind: "checkout" },
    { pattern: "/cart", kind: "checkout" },
    { pattern: "/api/checkout", kind: "checkout" },
    { pattern: "/account", kind: "account" },
    { pattern: "/my-account", kind: "account" },
    { pattern: "/settings", kind: "account" },
    { pattern: "/api/account", kind: "account" },
    { pattern: "/export", kind: "export", methods: ["GET", "POST"] },
    { pattern: "/api/export", kind: "export", methods: ["GET", "POST"] },
    { pattern: "/contact", kind: "contact" },
    { pattern: "/api/contact", kind: "contact" },
    { pattern: "/wp-comments-post.php", kind: "comment" },
  ],
  siteRoutes: {},
  ignorePaths: ["/api/site-analytics", "/api/forcefield", "/_vercel", "/monitoring", "/cdn-cgi"],
  recordAttested: false,
};

/** Is `path` the pattern itself or under it. */
function under(path: string, p: string): boolean {
  if (!p) return false;
  return path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`);
}

export interface StateChange {
  /** The action kind ("login", "checkout", ...), "api" for an unnamed API
   *  write, "form" for any other write. */
  kind: string;
  method: string;
}

/**
 * Is this request state-changing? A configured route wins (with its own
 * methods); otherwise any state-changing method on a path that is not a static
 * asset and not ignored. `staticAsset` is supplied by the caller (observe.ts
 * owns that rule). Pure.
 */
export function stateChangeOf(
  req: { site: string; path: string; method: string; staticAsset: boolean },
  rules: StateChangeRules = DEFAULT_STATE_CHANGE_RULES,
): StateChange | null {
  const method = (req.method ?? "").toUpperCase();
  const path = (req.path ?? "").toLowerCase();
  if (!path || req.staticAsset) return null;
  if (rules.ignorePaths.some((p) => under(path, p.toLowerCase()))) return null;
  const changing = rules.methods.map((m) => m.toUpperCase());
  const routes = [...(rules.siteRoutes?.[req.site] ?? []), ...rules.routes];
  for (const r of routes) {
    if (!under(path, r.pattern.toLowerCase())) continue;
    const allowed = (r.methods ?? changing).map((m) => m.toUpperCase());
    if (allowed.includes(method)) return { kind: r.kind, method };
    // A named route that this method does not change (a GET of /login) is a
    // read, not an action; stop rather than fall through to the generic rule.
    return null;
  }
  if (!changing.includes(method)) return null;
  return { kind: path === "/api" || path.startsWith("/api/") ? "api" : "form", method };
}

/** The principal side of a verdict, known only where a delegation was verified
 *  (the server boundary). */
export interface PrincipalEvidence {
  status: "verified" | "claimed";
  /** Verified only: does a presented scope cover this action's path? */
  withinMandate?: boolean;
}

export interface AccountabilityInput {
  /** The fingerprint.ts client class ("browser", "headless", "scanner", ...). */
  clientType: string;
  headerMismatch: boolean;
  /** hosting.ts label: "datacenter" | "residential" | "unknown". */
  hosting: string;
  /** SITE-ATTESTED session or service credential (never inferred). */
  authenticated: boolean;
  /** Lowercased header names (Fetch Metadata presence is read from here). */
  headerNames: readonly string[];
  /** The request is from a known allowlisted agent or presented a Web Bot Auth
   *  signature: the SOFTWARE is named, but not the person it acts for. */
  identifiedAgent: boolean;
  principal?: PrincipalEvidence;
}

export interface AccountabilityVerdict {
  class: AccountabilityClass;
  reason: AccountabilityReason;
  /** Would "hold for review" have held this action? Unaccountable automation,
   *  and a verified agent acting outside its mandate. Watch mode: recorded only. */
  wouldHold: boolean;
  /** Set for a verified principal only. */
  mandate?: "within" | "outside";
}

const FETCH_METADATA = ["sec-fetch-site", "sec-fetch-mode"];

/**
 * The accountability verdict for one state-changing request. Ordered strongest
 * proof first: a verified principal, then a site-attested session, then a
 * claimed-but-unverified principal, then the client's own signals. Pure.
 */
export function accountabilityVerdict(input: AccountabilityInput): AccountabilityVerdict {
  const p = input.principal;
  if (p?.status === "verified") {
    const within = p.withinMandate === true;
    return { class: "signed_principal", reason: "verified_principal", wouldHold: !within, mandate: within ? "within" : "outside" };
  }
  if (input.authenticated) return { class: "browser_session", reason: "site_attested_session", wouldHold: false };
  const held = (reason: AccountabilityReason): AccountabilityVerdict => ({ class: "unaccountable", reason, wouldHold: true });
  if (p?.status === "claimed") return held("principal_unverified");
  if (input.identifiedAgent) return held("agent_without_principal");
  if (input.clientType === "headless") return held("headless_browser");
  if (input.clientType === "browser") {
    if (input.headerMismatch) return held("header_mismatch");
    if (input.hosting === "datacenter") return held("browser_from_datacenter");
    const names = new Set(input.headerNames.map((h) => (h ?? "").toLowerCase()));
    if (!FETCH_METADATA.some((h) => names.has(h))) return held("no_fetch_metadata");
    return { class: "browser_session", reason: "browser_signals", wouldHold: false };
  }
  if (input.headerMismatch) return held("header_mismatch");
  return held("script_client");
}

/** The props an action carries on its event. Short keys, closed vocabularies,
 *  no PII (the principal itself is stamped by the server as props.principal). */
export function actionProps(change: StateChange, v: AccountabilityVerdict): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    accountability: v.class,
    acct_reason: v.reason,
    action_kind: change.kind,
    method: change.method,
    would_hold: v.wouldHold,
  };
  if (v.mandate) out.mandate = v.mandate;
  return out;
}

/** The action prop keys, in one place, so the ingest carries them past its
 *  props cap and withEnforcement copies them onto a rebuilt event. */
export const ACTION_PROP_KEYS = ["accountability", "acct_reason", "action_kind", "method", "would_hold", "mandate"] as const;

const KIND_RE = /^[a-z0-9_-]{1,32}$/;
const METHOD_RE = /^[A-Z]{3,7}$/;

/**
 * Validate action props from an untrusted body (the ingest boundary): only
 * known classes and reasons, a short kind and method, booleans as booleans.
 * Returns {} when the body carries no valid accountability class.
 */
export function coerceActionProps(raw: Record<string, unknown>): Record<string, string | boolean> {
  const cls = raw.accountability;
  if (typeof cls !== "string" || !(ACCOUNTABILITY_CLASSES as readonly string[]).includes(cls)) return {};
  const out: Record<string, string | boolean> = { accountability: cls };
  if (typeof raw.acct_reason === "string" && (ACCOUNTABILITY_REASONS as readonly string[]).includes(raw.acct_reason)) out.acct_reason = raw.acct_reason;
  if (typeof raw.action_kind === "string" && KIND_RE.test(raw.action_kind)) out.action_kind = raw.action_kind;
  if (typeof raw.method === "string" && METHOD_RE.test(raw.method)) out.method = raw.method;
  if (typeof raw.would_hold === "boolean") out.would_hold = raw.would_hold;
  if (raw.mandate === "within" || raw.mandate === "outside") out.mandate = raw.mandate;
  return out;
}

/**
 * Refine an edge verdict (already on `props`) with the principal the server
 * verified. A verified principal makes the action "signed_principal" with its
 * mandate; a claimed one makes it unaccountable unless the site attested the
 * session. Mutates and returns `props`; a no-op when props carry no action.
 */
export function applyPrincipalToAction(
  props: Record<string, string | number | boolean>,
  principal: PrincipalEvidence | null,
): Record<string, string | number | boolean> {
  if (typeof props.accountability !== "string" || !principal) return props;
  let v: AccountabilityVerdict | null = null;
  if (principal.status === "verified") {
    v = accountabilityVerdict({ clientType: "", headerMismatch: false, hosting: "", authenticated: false, headerNames: [], identifiedAgent: true, principal });
  } else if (props.acct_reason !== "site_attested_session") {
    v = { class: "unaccountable", reason: "principal_unverified", wouldHold: true };
  }
  if (!v) return props;
  props.accountability = v.class;
  props.acct_reason = v.reason;
  props.would_hold = v.wouldHold;
  if (v.mandate) props.mandate = v.mandate;
  else delete props.mandate;
  return props;
}

/** Coerce an untrusted ruleset field into StateChangeRules, or null (the
 *  caller then keeps the bundled defaults). Strict on shape, like the rest of
 *  coerceRuleset. */
export function coerceStateChangeRules(v: unknown): StateChangeRules | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const strArr = (x: unknown): string[] | null => (Array.isArray(x) && x.every((s) => typeof s === "string") ? (x as string[]) : null);
  const routeArr = (x: unknown): ActionRoute[] | null => {
    if (!Array.isArray(x)) return null;
    const out: ActionRoute[] = [];
    for (const r of x) {
      const o = r as Record<string, unknown> | null;
      if (!o || typeof o.pattern !== "string" || typeof o.kind !== "string" || !KIND_RE.test(o.kind)) return null;
      const methods = o.methods === undefined ? undefined : strArr(o.methods);
      if (methods === null) return null;
      out.push(methods ? { pattern: o.pattern, kind: o.kind, methods } : { pattern: o.pattern, kind: o.kind });
    }
    return out;
  };
  const methods = strArr(d.methods);
  const routes = routeArr(d.routes);
  const ignorePaths = strArr(d.ignorePaths);
  if (!methods || !routes || !ignorePaths) return null;
  const siteRoutes: Record<string, ActionRoute[]> = {};
  if (d.siteRoutes && typeof d.siteRoutes === "object" && !Array.isArray(d.siteRoutes)) {
    for (const [k, arr] of Object.entries(d.siteRoutes as Record<string, unknown>)) {
      const r = routeArr(arr);
      if (r) siteRoutes[k] = r;
    }
  }
  return { methods, routes, siteRoutes, ignorePaths, recordAttested: d.recordAttested === true };
}
