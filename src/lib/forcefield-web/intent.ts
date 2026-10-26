/**
 * Forcefield INTENT scoring: act on hostile intent before the exploit request.
 *
 * decideEnforcement judges one request on proof (a decoy trip, a payload, an
 * attack tool, an operator block). Most of an attack happens before any proof:
 * the actor maps the site, asks for products it does not run, and reaches for
 * config files. This module turns those precursors into a deterministic,
 * explainable score per session and steps the response up as it crosses fixed
 * thresholds:
 *
 *   none -> watch (record) -> tarpit (slow, decoy-eligible) -> block
 *
 * SAFETY RAILS (the same precision-first stance as the rest of Forcefield):
 *   - Intent alone never hard-blocks. "block" additionally requires PROOF in the
 *     same session (decoy taken, payload, attack tool, operator block) and a
 *     client-scoped session key (client IP + UA + header shape, held in memory
 *     only), so it is never fingerprint-wide.
 *   - A session keyed only by the hourly sig (no client IP) is shared by every
 *     visitor on the same browser + country, so a BROWSER client keyed that way
 *     is capped at "watch".
 *   - Carryover from another site only ever tarpits, and is only distributed for
 *     DISTINCTIVE fingerprints (never default curl / a library / a browser), each
 *     entry with its own expiry.
 *   - Welcomed agents and site-attested authenticated requests score nothing.
 *   - Posture: in watch mode every decision is computed and recorded with
 *     applied:false; nothing is slowed or blocked.
 *
 * PURE + EDGE-SAFE: no I/O, no model, no clock (nowMs is an input). The only
 * state is the bounded in-memory IntentLedger, which a caller owns. Vendored
 * into connected sites with the rest of the portable core.
 */
import type { ForcefieldRuleset } from "./ruleset";
import { TRAP_PATH_PREFIX } from "./decoy";

/* --------------------------------- model ---------------------------------- */

export type IntentSignalId =
  | "recon_foreign_product" // a path of a product the site does not run
  | "recon_foreign_runtime" // a server-side extension (.php/.jsp/...) the site's runtime never serves
  | "sensitive_probe" // an existing sensitive-path probe (.env, .git, ...)
  | "decoy_proximity" // poking around the decoy namespace without taking the decoy
  | "payload_shaped" // a parameter shaped like payload preparation (id=1', "><, ${)
  | "rapid_enumeration" // a non-browser client sweeping many distinct paths fast
  | "automation_client" // anonymous, non-welcomed automation (weak, never alone)
  | "carryover_hostile"; // proven hostile on a Forcefield site before (distributed)

export type IntentProofKind = "decoy" | "payload" | "attack_tool" | "blocked_fingerprint";

export type IntentAction = "none" | "watch" | "tarpit" | "block";

/**
 * Documented weights. A request contributes its strongest recon-class signal
 * once per distinct path; the weak per-session signals count once per window.
 * Chosen against 30 days of production traffic (see the PR): one stray recon
 * hit only reaches "watch"; two distinct foreign-product requests, or recon
 * plus a sensitive probe, reach "tarpit".
 */
export const INTENT_WEIGHTS: Readonly<Record<IntentSignalId, number>> = {
  recon_foreign_product: 3,
  recon_foreign_runtime: 3,
  sensitive_probe: 2,
  decoy_proximity: 3,
  payload_shaped: 2,
  rapid_enumeration: 2,
  automation_client: 1,
  carryover_hostile: 6,
};

/** Weight a PROOF adds to its session. A decoy taken, a named attack tool or an
 *  operator-blocked fingerprint reaches the block threshold alone; one payload
 *  needs a precursor (or a second payload), because a payload signature can, rarely,
 *  match a real user's input. */
export const PROOF_WEIGHTS: Readonly<Record<IntentProofKind, number>> = {
  decoy: 6,
  attack_tool: 6,
  blocked_fingerprint: 6,
  payload: 3,
};

export interface IntentThresholds {
  watch: number;
  tarpit: number;
  block: number;
}

/** Score thresholds. block also requires proof + a client-scoped key. */
export const INTENT_THRESHOLDS: Readonly<IntentThresholds> = { watch: 2, tarpit: 6, block: 6 };

/** One session's memory: signals older than this no longer count. */
export const INTENT_WINDOW_MS = 10 * 60_000;

/** Distinct non-browser paths inside RAPID_WINDOW_MS that count as a sweep. */
export const RAPID_DISTINCT_PATHS = 10;
export const RAPID_WINDOW_MS = 60_000;

/** Tarpit delay. Bounded so a slowed request still completes well inside any
 *  edge timeout; the cost to a scanner is per request, multiplied by its sweep. */
export const TARPIT_DELAY_MS = 2_000;
export const TARPIT_MAX_DELAY_MS = 4_000;

export interface IntentSignal {
  id: IntentSignalId;
  /** Stable, non-PII detail: the product id, runtime id, or probe id. */
  detail?: string;
}

/* ------------------------------ stack profile ----------------------------- */

/** What the site runs. `known: false` turns the recon signals OFF (precision
 *  first: without a profile we cannot tell native from foreign). */
export interface StackProfile {
  known: boolean;
  runtimes: string[];
  products: string[];
  /** Where it came from, for the audit trail. */
  source: "declared" | "unknown";
}

/** Bundled stack components: a declared stack token -> runtimes + products.
 *  "vercel" and "hosted" are Node hosts with no PHP/Java/.NET runtime. A token
 *  missing here makes the profile unknown (never guessed). */
export const DEFAULT_STACK_COMPONENTS: Readonly<Record<string, { runtimes: string[]; products: string[] }>> = {
  nextjs: { runtimes: ["node"], products: ["nextjs"] },
  vercel: { runtimes: ["node"], products: [] },
  hosted: { runtimes: ["node"], products: [] },
  static: { runtimes: [], products: [] },
  wordpress: { runtimes: ["php"], products: ["wordpress"] },
};

/** Server-side file extensions by runtime. A request for one of these on a site
 *  whose profile lacks the runtime cannot be served by it: pure recon. ".do" is
 *  deliberately absent (too short to be sure). */
export const DEFAULT_RUNTIME_EXTENSIONS: Readonly<Record<string, string[]>> = {
  php: [".php", ".php3", ".php4", ".php5", ".php7", ".phtml", ".phar"],
  aspnet: [".asp", ".aspx", ".ashx", ".asmx", ".axd"],
  java: [".jsp", ".jspx", ".jsf", ".action"],
  cgi: [".cgi", ".pl"],
  coldfusion: [".cfm", ".cfc"],
  appliance: [".esp"],
};

/**
 * Product path catalog: product id -> path patterns, all lowercase. A pattern
 * covers itself and everything below it; a trailing "*" is a raw prefix. Only
 * product-SPECIFIC paths are listed (no "/admin", "/login", "/api"), so a match
 * names the product the actor was looking for. WordPress comes from
 * ruleset.platformPaths.wordpress so there is one list. Sources: each vendor's
 * published advisory paths, and what our own production traffic requested in
 * 2026-09/10 (Bitrix, Fortinet, Pulse, GlobalProtect, Cisco ASA, Exchange ECP,
 * Laravel Ignition, Solr, JBoss, OFBiz, cPanel proxy subdomains).
 */
export const DEFAULT_PRODUCT_PATHS: Readonly<Record<string, string[]>> = {
  bitrix: ["/bitrix"],
  oracle_reports: ["/reports/rwservlet"],
  oracle_ebs: ["/oa_html"],
  fortinet_sslvpn: ["/remote/login", "/remote/logincheck", "/remote/fgt_lang", "/remote/info"],
  ivanti_connect_secure: ["/dana-na", "/dana-cached", "/dana-ws"],
  paloalto_globalprotect: ["/global-protect", "/ssl-vpn"],
  citrix_netscaler: ["/vpn/index.html", "/vpns", "/logon/logonpoint", "/nf/auth"],
  cisco_asa: ["/+cscoe+", "/+cscot+", "/+cscol+"],
  sonicwall: ["/cgi-bin/welcome", "/sslvpnlogin.html"],
  f5_bigip: ["/tmui", "/mgmt/tm"],
  ms_exchange: ["/owa", "/ecp", "/ews", "/autodiscover", "/mapi"],
  ms_rdweb: ["/rdweb"],
  joomla: ["/administrator"],
  drupal: ["/sites/default", "/core/install.php"],
  magento: ["/downloader", "/magento_version"],
  laravel: ["/_ignition", "/telescope", "/vendor/laravel-filemanager"],
  spring_boot: ["/actuator"],
  apache_solr: ["/solr"],
  jboss: ["/jmx-console", "/invoker", "/web-console"],
  tomcat: ["/manager/html", "/host-manager"],
  apache_ofbiz: ["/webtools/control"],
  geoserver: ["/geoserver"],
  cpanel: ["/___proxy_subdomain_*", "/cpanel", "/whm"],
  vmware_vcenter: ["/ui/vropspluginui", "/vsphere-client"],
  ivanti_epmm: ["/mifs"],
  moveit: ["/moveitisapi"],
  sap_netweaver: ["/developmentserver/metadatauploader"],
  phpmyadmin: ["/phpmyadmin"],
};

function lc(s: string): string {
  return (s ?? "").toLowerCase();
}

/** Resolve the site's stack profile from what the SITE declared: an explicit
 *  stack list, else its platform. Deterministic; unknown tokens -> unknown. */
export function resolveStackProfile(
  input: { stack?: readonly string[]; platform?: string },
  ruleset?: Pick<ForcefieldRuleset, "stackComponents">,
): StackProfile {
  const components = { ...DEFAULT_STACK_COMPONENTS, ...(ruleset?.stackComponents ?? {}) };
  const tokens = (input.stack && input.stack.length > 0 ? input.stack : input.platform ? [input.platform] : []).map(lc);
  if (tokens.length === 0) return { known: false, runtimes: [], products: [], source: "unknown" };
  const runtimes = new Set<string>();
  const products = new Set<string>();
  for (const t of tokens) {
    const c = components[t];
    if (!c) return { known: false, runtimes: [], products: [], source: "unknown" };
    c.runtimes.forEach((r) => runtimes.add(lc(r)));
    c.products.forEach((p) => products.add(lc(p)));
  }
  return { known: true, runtimes: [...runtimes], products: [...products], source: "declared" };
}

function underProductPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern || path.startsWith(`${pattern}/`);
}

/** The product a path belongs to, or null. Pure. */
export function productForPath(path: string, ruleset?: Pick<ForcefieldRuleset, "productPaths" | "platformPaths">): string | null {
  const p = lc(path);
  const catalog: Record<string, string[]> = { ...DEFAULT_PRODUCT_PATHS, ...(ruleset?.productPaths ?? {}) };
  const wp = ruleset?.platformPaths?.wordpress;
  if (wp && wp.length) catalog.wordpress = wp.map(lc);
  for (const [product, patterns] of Object.entries(catalog)) {
    if (patterns.some((pat) => underProductPattern(p, lc(pat)))) return product;
  }
  return null;
}

/** The server-side runtime a path's extension needs, or null. */
export function runtimeForPath(path: string, ruleset?: Pick<ForcefieldRuleset, "runtimeExtensions">): string | null {
  const p = lc(path);
  const last = p.slice(p.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0 && !(dot === 0 && last.length > 1)) return null;
  const ext = last.slice(dot);
  const table = { ...DEFAULT_RUNTIME_EXTENSIONS, ...(ruleset?.runtimeExtensions ?? {}) };
  for (const [runtime, exts] of Object.entries(table)) if (exts.includes(ext)) return runtime;
  return null;
}

/** The recon signal for one path under a stack profile, or null. A product the
 *  site runs (or any path when the profile is unknown) is never recon, so a
 *  WordPress site requesting /wp-admin scores nothing. */
export function reconSignal(
  path: string,
  profile: StackProfile,
  ruleset?: Pick<ForcefieldRuleset, "productPaths" | "platformPaths" | "runtimeExtensions">,
): IntentSignal | null {
  if (!profile.known) return null;
  const product = productForPath(path, ruleset);
  if (product && !profile.products.includes(product)) return { id: "recon_foreign_product", detail: product };
  const runtime = runtimeForPath(path, ruleset);
  if (runtime && !profile.runtimes.includes(runtime) && !(product && profile.products.includes(product))) {
    return { id: "recon_foreign_runtime", detail: runtime };
  }
  return null;
}

/* ---------------------------- per-request signals --------------------------- */

/** Parameter values shaped like payload PREPARATION, below the payload
 *  signatures in enforce.ts: a numeric value with a trailing quote (the classic
 *  SQLi probe "id=1'"), a quote that closes an attribute and opens a tag, a
 *  template / expression opener, or a NUL byte. A person's text input does not
 *  look like these (an apostrophe mid-word does not match). */
const PAYLOAD_SHAPED: readonly RegExp[] = [
  /[?&][^=&]+=\d+(?:'|%27|"|%22)(?:&|$)/i,
  /(?:'|%27|"|%22)\s*(?:>|%3e)\s*(?:<|%3c)/i,
  /(?:\$\{|%24%7b|\{\{|%7b%7b)/i,
  /%00/,
];

export function payloadShaped(rawUrl: string): boolean {
  const q = (rawUrl ?? "").indexOf("?");
  if (q === -1) return false;
  const query = rawUrl.slice(q);
  return PAYLOAD_SHAPED.some((re) => re.test(query));
}

export interface IntentRequest {
  path: string;
  rawUrl?: string;
  /** fingerprint.ts client type. */
  clientType: string;
  authenticated?: boolean;
  /** A welcomed known agent (not a proven impersonator). */
  welcomed?: boolean;
  /** observe.ts probe id when the request was a sensitive probe. */
  probe?: string | null;
  /** Static page sub-resource (observe.ts isStaticAsset). */
  staticAsset?: boolean;
}

/** The trap paths' namespace: the decoy prefix itself and the parent of each
 *  configured trap. Poking here without taking the decoy is proximity. */
function decoyProximity(path: string, trapPaths: readonly string[]): boolean {
  const p = lc(path);
  if (trapPaths.some((t) => p === lc(t) || p.startsWith(`${lc(t)}/`))) return false; // the decoy itself is proof, not proximity
  if (p === TRAP_PATH_PREFIX || p.startsWith(`${TRAP_PATH_PREFIX}/`)) return true;
  return false;
}

/** The per-request signals (everything except the session-level sweep and
 *  carryover, which the ledger adds). Pure. */
export function intentSignalsFor(
  req: IntentRequest,
  profile: StackProfile,
  ruleset: Pick<ForcefieldRuleset, "trapPaths" | "productPaths" | "platformPaths" | "runtimeExtensions">,
): IntentSignal[] {
  if (req.authenticated === true || req.welcomed === true) return [];
  const out: IntentSignal[] = [];
  const recon = reconSignal(req.path, profile, ruleset);
  if (recon) out.push(recon);
  else if (req.probe) {
    // A probe pattern under a product the site RUNS is its own path (a
    // WordPress site's /wp-admin), whatever the observation called it.
    const own = productForPath(req.path, ruleset);
    if (!(profile.known && own && profile.products.includes(own))) out.push({ id: "sensitive_probe", detail: req.probe });
  }
  if (decoyProximity(req.path, ruleset.trapPaths)) out.push({ id: "decoy_proximity" });
  if (payloadShaped(req.rawUrl ?? req.path)) out.push({ id: "payload_shaped" });
  const automation = req.clientType !== "browser" && req.clientType !== "known_crawler";
  if (automation && !req.staticAsset) out.push({ id: "automation_client", detail: req.clientType });
  return out;
}

/* --------------------------------- ledger ---------------------------------- */

interface Entry {
  ts: number;
  id: IntentSignalId | "proof";
  /** Dedupe key: the same signal on the same path counts once per window. */
  key: string;
  weight: number;
}

interface SessionState {
  entries: Entry[];
  /** Recent non-browser request paths for the sweep detector. */
  paths: { ts: number; path: string }[];
  proof?: { kind: IntentProofKind; ts: number };
  /** Highest action already reported, so the caller records transitions only. */
  reported: IntentAction;
}

export interface SessionIntent {
  score: number;
  reasons: IntentSignalId[];
  /** Product / runtime ids seen (for the "held back because" line). */
  details: string[];
  proof?: IntentProofKind;
}

const ACTION_RANK: Record<IntentAction, number> = { none: 0, watch: 1, tarpit: 2, block: 3 };

/**
 * Bounded per-instance memory of recent sessions. The key is computed by the
 * caller (sessionKey) and is a non-reversible hash; no IP is ever stored here.
 * Serverless instances each keep their own ledger, so this under-counts a
 * distributed actor, never over-counts one client.
 */
export class IntentLedger {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly maxKeys = 5_000, private readonly maxEntries = 64) {}

  get size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  private state(key: string, nowMs: number): SessionState {
    let s = this.sessions.get(key);
    if (s) {
      // Refresh recency for eviction (Map iteration order is insertion order).
      this.sessions.delete(key);
    } else {
      s = { entries: [], paths: [], reported: "none" };
    }
    this.sessions.set(key, s);
    while (this.sessions.size > this.maxKeys) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const cut = nowMs - INTENT_WINDOW_MS;
    s.entries = s.entries.filter((e) => e.ts > cut);
    if (s.proof && s.proof.ts <= cut) s.proof = undefined;
    if (s.entries.length === 0 && !s.proof) s.reported = "none";
    return s;
  }

  /**
   * Record one request's signals (and proof, when decideEnforcement proved it
   * hostile) and return the session's current intent. Never throws.
   */
  note(
    key: string,
    nowMs: number,
    input: { path: string; signals: readonly IntentSignal[]; proof?: IntentProofKind; nonBrowser?: boolean; carryover?: boolean },
  ): SessionIntent {
    try {
      const s = this.state(key, nowMs);
      const add = (id: IntentSignalId, dedupe: string) => {
        if (s.entries.some((e) => e.key === dedupe)) return;
        s.entries.push({ ts: nowMs, id, key: dedupe, weight: INTENT_WEIGHTS[id] });
        if (s.entries.length > this.maxEntries) s.entries.shift();
      };
      const p = lc(input.path);
      for (const sig of input.signals) {
        // Weak session-level tells count once per window; recon-class signals
        // count once per distinct path.
        const once = sig.id === "automation_client";
        add(sig.id, once ? sig.id : `${sig.id}|${sig.detail ?? ""}|${p}`);
      }
      if (input.carryover) add("carryover_hostile", "carryover_hostile");
      if (input.nonBrowser) {
        s.paths = s.paths.filter((x) => x.ts > nowMs - RAPID_WINDOW_MS);
        if (!s.paths.some((x) => x.path === p)) s.paths.push({ ts: nowMs, path: p });
        if (s.paths.length > RAPID_DISTINCT_PATHS * 2) s.paths.shift();
        if (s.paths.length >= RAPID_DISTINCT_PATHS) add("rapid_enumeration", "rapid_enumeration");
      }
      if (input.proof) {
        s.proof = { kind: input.proof, ts: nowMs };
        const pk = `proof|${input.proof}|${p}`;
        if (!s.entries.some((e) => e.key === pk)) {
          s.entries.push({ ts: nowMs, id: "proof", key: pk, weight: PROOF_WEIGHTS[input.proof] });
          if (s.entries.length > this.maxEntries) s.entries.shift();
        }
      }
      return summarize(s, this.detailsOf(s));
    } catch {
      return { score: 0, reasons: [], details: [] };
    }
  }

  private detailsOf(s: SessionState): string[] {
    const out = new Set<string>();
    for (const e of s.entries) {
      if (e.id === "proof") continue;
      const parts = e.key.split("|");
      if (parts.length >= 2 && parts[1]) out.add(parts[1]);
    }
    return [...out].slice(0, 6);
  }

  /**
   * True exactly once per step-up: when `action` outranks what this session
   * already reported. The caller records an intent event only then, so a
   * tarpitted sweep yields one event per transition, not one per request.
   */
  shouldReport(key: string, action: IntentAction): boolean {
    const s = this.sessions.get(key);
    if (!s || ACTION_RANK[action] <= ACTION_RANK[s.reported]) return false;
    s.reported = action;
    return true;
  }
}

function summarize(s: SessionState, details: string[]): SessionIntent {
  const score = s.entries.reduce((n, e) => n + e.weight, 0);
  const reasons = [...new Set(s.entries.map((e) => e.id).filter((id): id is IntentSignalId => id !== "proof"))];
  return { score, reasons, details, ...(s.proof ? { proof: s.proof.kind } : {}) };
}

/* -------------------------------- decision --------------------------------- */

export interface IntentDecision {
  /** What the policy decided, whatever the posture. */
  action: IntentAction;
  /** True only when the posture lets the caller act (enforce). */
  applied: boolean;
  score: number;
  reasons: IntentSignalId[];
  details: string[];
  proof?: IntentProofKind;
  /** Delay to apply when action is tarpit and applied. */
  delayMs: number;
  /** The request may be answered with a decoy body (tarpit tier). */
  decoy: boolean;
  /** "client" = IP-scoped in-memory key; "sig" = the shared hourly sig. */
  keyScope: "client" | "sig";
  /** One plain sentence for alerts and the board. */
  summary: string;
}

export interface IntentDecideOptions {
  /** "enforce" lets the caller act; anything else records only. */
  posture: "watch" | "enforce";
  keyScope: "client" | "sig";
  /** The request's own client type: a browser on a sig-scoped key is capped
   *  at watch (that key is shared by real visitors). */
  clientType: string;
  /** Override the documented thresholds (replay tuning only). */
  thresholds?: IntentThresholds;
}

const REASON_TEXT: Record<IntentSignalId, string> = {
  recon_foreign_product: "asked for a product this site does not run",
  recon_foreign_runtime: "asked for server-side files this site's runtime never serves",
  sensitive_probe: "probed sensitive paths",
  decoy_proximity: "searched around a decoy",
  payload_shaped: "sent payload-shaped parameters",
  rapid_enumeration: "swept many paths in under a minute",
  automation_client: "anonymous automation",
  carryover_hostile: "was proven hostile on a Forcefield site before",
};

/** Map a session's intent to the step-up action. Deterministic + pure. */
export function decideIntent(intent: SessionIntent, opts: IntentDecideOptions): IntentDecision {
  const t = opts.thresholds ?? INTENT_THRESHOLDS;
  let action: IntentAction = "none";
  if (intent.score >= t.watch) action = "watch";
  if (intent.score >= t.tarpit) action = "tarpit";
  // block: proof in this session + enough intent + a client-scoped key. Never on
  // intent alone, never on a shared sig.
  if (intent.proof && intent.score >= t.block && opts.keyScope === "client") action = "block";
  // A shared sig on a browser client is many people: record only.
  if (opts.keyScope === "sig" && opts.clientType === "browser" && ACTION_RANK[action] > ACTION_RANK.watch) action = "watch";

  const applied = opts.posture === "enforce" && (action === "tarpit" || action === "block");
  const delayMs =
    action === "tarpit" ? Math.min(TARPIT_MAX_DELAY_MS, TARPIT_DELAY_MS + Math.max(0, intent.score - t.tarpit) * 250) : 0;
  const why = intent.reasons.filter((r) => r !== "automation_client" || intent.reasons.length === 1).map((r) => REASON_TEXT[r]);
  const summary =
    action === "none"
      ? "no hostile intent"
      : `${action === "block" ? "blocked" : action === "tarpit" ? "held back early" : "watched"} because the session ${why.join(", ") || "showed intent"}` +
        (intent.details.length ? ` (${intent.details.join(", ")})` : "") +
        (intent.proof ? `, then proved hostile (${intent.proof})` : "");
  return {
    action,
    applied,
    score: intent.score,
    reasons: intent.reasons,
    details: intent.details,
    ...(intent.proof ? { proof: intent.proof } : {}),
    delayMs,
    decoy: action === "tarpit",
    keyScope: opts.keyScope,
    summary,
  };
}

/* ------------------------------ session keying ----------------------------- */

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The in-memory session key. With a client IP it is a hash of (ip, ua, header
 *  shape) - one client - and the IP is discarded. Without one it falls back to
 *  the hourly sig, which many visitors share, and says so. */
export function intentSessionKey(input: { ip?: string; userAgent: string; headerShape: string; sig: string }): {
  key: string;
  scope: "client" | "sig";
} {
  if (input.ip) return { key: `c:${fnv(`${input.ip}|${input.userAgent}|${input.headerShape}`)}`, scope: "client" };
  return { key: `s:${input.sig}`, scope: "sig" };
}

/* -------------------------------- carryover -------------------------------- */

export interface CarryoverEntry {
  fp: string;
  /** ISO expiry; an expired entry no longer carries over. */
  expiresAt: string;
}

/** True when this fingerprint was proven hostile on a Forcefield site and the
 *  distributed entry has not expired. The list is distinctive-only by
 *  construction (the server never distributes a generic fingerprint); a browser
 *  client is still never carried over (defense in depth). */
export function carriesOver(fp: string, clientType: string, entries: readonly CarryoverEntry[] | undefined, nowMs: number): boolean {
  if (!fp || !entries || entries.length === 0 || clientType === "browser") return false;
  for (const e of entries) {
    if (e.fp !== fp) continue;
    const exp = Date.parse(e.expiresAt);
    if (Number.isFinite(exp) && exp > nowMs) return true;
  }
  return false;
}

/** Validate an untrusted carryover list (ruleset field): malformed -> []. */
export function coerceCarryover(v: unknown): CarryoverEntry[] {
  if (!Array.isArray(v)) return [];
  const out: CarryoverEntry[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return [];
    const e = x as Record<string, unknown>;
    if (typeof e.fp !== "string" || typeof e.expiresAt !== "string" || !Number.isFinite(Date.parse(e.expiresAt))) return [];
    out.push({ fp: e.fp, expiresAt: e.expiresAt });
  }
  return out;
}

/* ------------------------------ event props -------------------------------- */

/** The props of a site.intent_scored event: ids and counts only, no PII,
 *  within the ingest's 12-key cap. */
export function intentEventProps(
  d: IntentDecision,
  base: { site: string; sig: string; fp: string; clientType: string },
): Record<string, string | number | boolean> {
  return {
    site: base.site,
    sig: base.sig,
    fp: base.fp,
    client_type: base.clientType,
    intent_action: d.action,
    intent_applied: d.applied,
    intent_score: d.score,
    intent_reasons: d.reasons.join(",").slice(0, 120),
    intent_details: d.details.join(",").slice(0, 120),
    intent_scope: d.keyScope,
    ...(d.proof ? { intent_proof: d.proof } : {}),
  };
}
