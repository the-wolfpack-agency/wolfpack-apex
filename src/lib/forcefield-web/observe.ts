/**
 * Forcefield for the Web - the reusable, ruleset-driven observer.
 *
 * This is the ONE detection function every connected site runs. Given a request
 * and the current ruleset (fetched centrally, see ruleset.ts), it returns the
 * site-event to forward, or null for a normal visitor. It generalizes what used
 * to be Instinct-specific: the site passes its `surface` tag, everything else
 * comes from the shared ruleset, so adding a scanner signature or a trap path
 * happens ONCE (in the ruleset) and every site follows.
 *
 * PURE + EDGE-SAFE, MONITOR-ONLY: no I/O, produces an observation only, never a
 * block decision (props record posture "monitor", blocked false). A caller that
 * DID enforce stamps the outcome afterwards with withEnforcement(), so the stored
 * row says what actually happened to the request.
 */
import { classifyWebRequest } from "./classify";
import { classifyClient, headerSignature, operatorFingerprint, type ClientFingerprint } from "./fingerprint";
import { classifyHosting, datacenterPrefixesFrom, verifyAgentByRanges, type AgentVerification } from "./hosting";
import { detectHeaderAttack, detectPayload, PAYLOAD_CWE } from "./enforce";
import type { ForcefieldRuleset } from "./ruleset";

export type ForcefieldEventType =
  | "site.page_viewed"
  | "site.agent_welcomed"
  | "site.agent_flagged"
  | "site.agent_trap_tripped"
  | "site.agent_probed_sensitive"
  | "site.agent_payload_attack"
  | "site.agent_high_rate";

export interface Observation {
  type: ForcefieldEventType;
  path: string;
  props: Record<string, string | number | boolean>;
}

export interface ObserveInput {
  /** The property/site this request hit (e.g. "instinct", "ogiam.com"). */
  site: string;
  path: string;
  method: string;
  userAgent: string;
  country: string;
  /** Lowercased list of the request's header names (for the header-order sig). */
  headerNames: readonly string[];
  /** The request's `Accept` header (used to tell a page navigation from an
   *  asset/XHR when `Sec-Fetch-Dest` is absent). Optional. */
  accept?: string;
  /** The request's `Sec-Fetch-Dest` header - "document" for a top-level page
   *  navigation. The strongest human-page-view signal (browser-only). Optional. */
  secFetchDest?: string;
  /** The client IP (from the edge). Classified to a hosting label and then
   *  DISCARDED - never stored. Optional; absent -> hosting "unknown". */
  ip?: string;
  /** The full request target (pathname + query), so an injection payload in the
   *  query is seen. Optional; falls back to `path`. */
  rawUrl?: string;
  /** SITE-ATTESTED: true only when the site itself verified a real signed-in
   *  session or service credential for this request (never inferred from the
   *  mere presence of a cookie/authorization header, which anyone can send).
   *  Optional; absent = anonymous. */
  authenticated?: boolean;
  /** VERIFIED synthetic monitor: the request presented x-forcefield-synthetic
   *  equal to FORCEFIELD_SYNTHETIC_TOKEN (isSyntheticMonitor). Set only by a
   *  caller that ran that check; never derived from the user agent. Stamped as
   *  props.synthetic so our own probes do not page anyone. Optional. */
  synthetic?: boolean;
  /** The platform the site runs on (e.g. "wordpress"), so that platform's own
   *  paths (ruleset.platformPaths) are not reported as recon. Optional. */
  platform?: string;
  nowMs: number;
}

/** A file-extension asset, an API call, or a Next internal - never a page view. */
function isNonPagePath(path: string): boolean {
  if (path === "/api" || path.startsWith("/api/")) return true;
  if (path.startsWith("/_next/")) return true;
  // A trailing file extension (.js, .css, .png, .ico, .map, .woff2, ...).
  return /\.[a-z0-9]{1,8}$/i.test(path);
}

/**
 * Is this a real human page view? A top-level HTML document navigation via GET.
 * `Sec-Fetch-Dest: document` is the definitive browser signal; when it is absent
 * we fall back to an `Accept: text/html` GET. Assets, API calls, XHR/fetch, and
 * non-GET methods are excluded, so this counts pages a person actually loaded -
 * the same thing ogiam.com's analytics counts, now for every monitored property.
 */
function isHumanPageView(input: ObserveInput): boolean {
  if (input.method.toUpperCase() !== "GET") return false;
  if (isNonPagePath(input.path)) return false;
  const dest = (input.secFetchDest ?? "").toLowerCase();
  if (dest) return dest === "document";
  return (input.accept ?? "").toLowerCase().includes("text/html");
}

/** A stable, non-PII session key: UA + country + hour bucket + header-order hash,
 *  so one actor's requests within an hour cluster, and header shape sharpens the
 *  resolution (survives UA spoofing). Edge-safe FNV-1a. */
function sessionSig(userAgent: string, country: string, headerNames: readonly string[], nowMs: number): string {
  const bucket = Math.floor(nowMs / 3_600_000);
  const s = `${userAgent}|${country}|${bucket}|${headerSignature(headerNames)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Is `path` the pattern itself or under it ("/wp-admin" covers "/wp-admin/x";
 *  a pattern ending in "/" is a pure prefix). */
function underPattern(path: string, p: string): boolean {
  return path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** A dotfile pattern ("/.env", "/.git") also covers its editor/backup/stage
 *  variants: "/.env.production", "/.env.bak", "/.env~". Requires the "." or "~"
 *  right after the name, so "/.environment" and "/.envoy" are NOT "/.env". */
function dotfileVariant(path: string, p: string): boolean {
  const last = p.slice(p.lastIndexOf("/") + 1);
  if (!last.startsWith(".") || last.length < 2 || p.endsWith("/")) return false;
  return path.startsWith(`${p}.`) || path === `${p}~`;
}

/** Does the path hit a sensitive/nonexistent recon path? Exact, one segment
 *  deeper, or a dotfile variant (see dotfileVariant). A pattern that is NATIVE to
 *  the site's declared platform (ruleset.platformPaths[platform]) is skipped, so a
 *  WordPress site's own /wp-login.php is not recon there. Returns the matched
 *  pattern, or null. */
function matchedSensitive(
  path: string,
  sensitivePaths: readonly string[],
  nativePaths: readonly string[] = [],
): string | null {
  for (const p of sensitivePaths) {
    if (!(underPattern(path, p) || dotfileVariant(path, p))) continue;
    if (nativePaths.some((n) => underPattern(p, n))) continue;
    return p;
  }
  return null;
}

/** Committed TEMPLATES of a .env file (no secrets in them), skipped below a
 *  subdirectory so a code-browsing or docs route that shows one is not recon. */
const DOTENV_TEMPLATE_SEGMENT = /^\.env\.(?:example|sample|template|dist)$/;

/** A .env file BELOW the root ("/api/.env", "/app/backend/.env.production",
 *  "/x/.env/..."): scanners sweep every framework subdirectory, not just "/.env",
 *  and a sensitivePaths pattern only anchors at the root. Fires on a path
 *  SEGMENT that is exactly ".env", ".env~" or ".env.<suffix>", so "/environment",
 *  "/api/.envoy", "/assets/env.js" and "/blog/what-is-a-.env-file" are NOT it.
 *  Template copies (.env.example etc.) are skipped at depth. The root-level
 *  variants stay with sensitivePaths + dotfileVariant. Report-only. */
function nestedDotenvProbe(path: string): string | null {
  const segs = path.toLowerCase().split("/");
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (s === ".env" || s === ".env~" || (s.startsWith(".env.") && s.length > 5 && !DOTENV_TEMPLATE_SEGMENT.test(s))) {
      return "nested_dotenv";
    }
  }
  return null;
}

/**
 * Anonymous calls to WordPress PLUGIN endpoints with a published missing-auth
 * flaw. On a site that declares platform "wordpress", core paths such as
 * /wp-admin/admin-ajax.php and /wp-json are its own (platformPaths), so the path
 * alone is never the reason: only the named plugin action/route is, and only
 * when WordPress did NOT attest a signed-in user (the plugin forwards
 * is_user_logged_in()). Both endpoints exist for a logged-in editor, so an
 * anonymous call has no legitimate caller. Report-only, like every probe.
 *   UpdraftCentral AJAX handler, missing authorization (UpdraftPlus 1.22.14 to
 *   1.23.2): https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/updraftplus/updraft-plus-12214-to-1232-privilege-escalation-via-updraft-central-ajax-handler
 *   Rank Math rankmath/v1/updateMeta without a permission_callback,
 *   CVE-2020-11514 (CVSS 9.8): https://nvd.nist.gov/vuln/detail/CVE-2020-11514
 */
function wpPluginAbuseProbe(path: string, rawUrl: string | undefined, authenticated: boolean): string | null {
  if (authenticated) return null;
  const lower = path.toLowerCase();
  const raw = rawUrl ?? path;
  const q = raw.indexOf("?");
  let params: URLSearchParams | null = null;
  try {
    params = q === -1 ? null : new URLSearchParams(raw.slice(q + 1));
  } catch {
    params = null;
  }
  // admin-ajax.php at the root or under a subdirectory install ("/blog/wp-admin/...").
  if (lower === "/wp-admin/admin-ajax.php" || lower.endsWith("/wp-admin/admin-ajax.php")) {
    const action = (params?.get("action") ?? "").toLowerCase();
    if (action.startsWith("updraft_central")) return "wp_plugin_updraftcentral_ajax";
  }
  // The REST route, by pretty permalink (/wp-json/<route>) or the plain
  // ?rest_route=<route> form. WordPress matches REST routes case-insensitively.
  const at = lower.indexOf("/wp-json/");
  let route = at === -1 ? (params?.get("rest_route") ?? "").toLowerCase() : lower.slice(at + "/wp-json".length);
  // trim trailing slashes without a regex (/\/+$/ is polynomial on a long run of '/': CodeQL js/polynomial-redos)
  let end = route.length;
  while (end > 0 && route.charCodeAt(end - 1) === 47) end--;
  route = route.slice(0, end);
  if (route === "/rankmath/v1/updatemeta") return "wp_plugin_rankmath_updatemeta";
  return null;
}

/** The named probe class (ruleset.probeClasses) a matched sensitive pattern
 *  belongs to, e.g. "ai_tool_config", or null. A label only: it never changes
 *  whether or how the request is reported or blocked. */
function probeClassOf(pattern: string, probeClasses: ForcefieldRuleset["probeClasses"]): string | null {
  for (const [cls, patterns] of Object.entries(probeClasses ?? {})) {
    if (patterns.includes(pattern)) return cls;
  }
  return null;
}

/** OpenAI's ChatGPT agent signs requests with Web Bot Auth (RFC 9421 HTTP
 *  Message Signatures): Signature-Agent + Signature + Signature-Input headers
 *  (https://help.openai.com/en/articles/11845367-chatgpt-agent-allowlisting).
 *  We see header NAMES only, so this records that the request PRESENTED a
 *  signature, not that it verified - props.agent_verification stays honest. */
function presentsSignedAgent(names: ReadonlySet<string>): boolean {
  return names.has("signature-agent") && names.has("signature") && names.has("signature-input");
}

/** UpdraftCentral's RPC client identifies as "class-udrpc.php/<ver>; <url>". The
 *  stolen-key attacker's UA carries "class-udrpc.php" WITHOUT the version and URL
 *  (Patchstack: https://patchstack.com/articles/updraftcentral-key-compromise-wordpress-backdoors/).
 *  On a non-WordPress site any UpdraftCentral command is recon. Report-only. */
/** A genuine client: a version right after the script name, then the dashboard
 *  URL whose HOST is teamupdraft.com (or a subdomain). Anchored on the host so a
 *  forger cannot pass by mentioning "teamupdraft.com" anywhere in the string. */
const GENUINE_UDRPC_UA = /class-udrpc\.php\/\d[\d.]*;\s*https?:\/\/(?:[a-z0-9-]+\.)*teamupdraft\.com(?:[/:?#\s]|$)/;

function updraftCentralProbe(userAgent: string, platform: string | undefined): string | null {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua.includes("class-udrpc.php")) return null;
  if (platform !== "wordpress") return "updraftcentral_command";
  return GENUINE_UDRPC_UA.test(ua) ? null : "updraftcentral_forged_client";
}

/** The planted UpdraftCentral backdoors are triggered by a query parameter whose
 *  name starts with "_" and whose value is a 32-char token; Patchstack publishes
 *  this exact detection regex (same source as above). Only meaningful on a
 *  WordPress site, report-only (a weak shape match, never a block). */
const WP_BACKDOOR_TRIGGER = /[?&]_[A-Za-z0-9]{4,10}=[A-Za-z0-9_]{32}(?:[&"\s]|$)/;

/**
 * A static sub-resource of a page load (script, style, image, font, the PWA
 * service worker / manifest) - NOT an app endpoint. A headless browser fetches
 * a dozen of these per visit; flagging each one turned ONE agent visit into a
 * dozen "flagged" events and buried the real signal (measured 2026-09-25: /sw.js,
 * the logo and manifest.json were ~75% of all flags). We suppress the WEAK flags
 * (headless / header-spoof) on these paths. `/api` is deliberately EXCLUDED - a
 * client hitting an API path is signal, not a page sub-resource - and named
 * hostile tools (sqlmap, python-requests) are still flagged on any path.
 */
const STATIC_ASSET_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|webmanifest)$/i;
export function isStaticAsset(path: string): boolean {
  if (path.startsWith("/api/") || path === "/api") return false;
  if (path.startsWith("/_next/")) return true;
  if (path === "/sw.js" || path === "/manifest.json" || path === "/favicon.ico") return true;
  return STATIC_ASSET_RE.test(path);
}

/** The per-request keys every Forcefield event carries: the hourly session sig,
 *  the STABLE operator fingerprint (header-order shape bound to the client's
 *  tool, NOT time-bucketed - the key an admin "Block operator" is enforced by),
 *  and the client classification. Exported so the observe route can key a rate
 *  event the same way as every other event. */
export function clientKeys(
  input: Pick<ObserveInput, "userAgent" | "country" | "headerNames" | "nowMs">,
  ruleset: ForcefieldRuleset,
): { sig: string; fp: string; client: ClientFingerprint } {
  const client = classifyClient(input.userAgent, input.headerNames, ruleset.toolSignatures);
  return {
    sig: sessionSig(input.userAgent, input.country, input.headerNames, input.nowMs),
    // A legit integration that only shares a header shape (but runs a different
    // tool) gets a different fp and is never caught by an operator block.
    fp: operatorFingerprint(input.headerNames, client.tool, client.clientType),
    client,
  };
}

/** The base props of an agent event (shared by observeRequest and the
 *  block-record path in withEnforcement). */
function agentProps(
  input: ObserveInput,
  ruleset: ForcefieldRuleset,
  agentId: string | undefined,
): Record<string, string | number | boolean> {
  const { sig, fp, client } = clientKeys(input, ruleset);
  const props: Record<string, string | number | boolean> = {
    sig,
    fp,
    // Persisted as `site` (NOT `surface`): some properties already emit a
    // `props.surface` for the UI element an event came from (e.g. "dropdown",
    // "mobile"), so reusing it here would collide on the board's property filter.
    site: input.site,
    posture: "monitor",
    action: "report",
    blocked: false,
    agent: agentId ?? "unidentified",
    client_type: client.clientType,
    // Hosting: datacenter (cloud/hosting network) vs residential. A "browser"
    // from a datacenter is almost certainly automation - it CONFIRMS the client
    // class. Classified against the FULL prefix set the ruleset distributes (or
    // the bundled seed when absent); the IP is discarded, only this label stored.
    hosting: classifyHosting(input.ip, datacenterPrefixesFrom(ruleset.datacenterPrefixes)),
  };
  if (client.tool) props.tool = client.tool;
  return props;
}

/** Stamp the site attestation LAST (after attack / cwe, so a size-capped ingest
 *  keeps the attack class; the ingest carries these two marks explicitly). Called
 *  by observeRequest AND the block-record path in withEnforcement, so a hostile
 *  event from our own attested traffic carries the mark however it was recorded.
 *  The alert scan excludes props.synthetic events. */
function stampAttestation(props: Record<string, string | number | boolean>, input: ObserveInput): void {
  if (input.authenticated === true || input.synthetic === true) props.authenticated = true;
  if (input.synthetic === true) props.synthetic = true;
}

/**
 * Inspect one request against the current ruleset. Most-severe first: a decoy
 * trip, then a payload / header attack, then a sensitive-path probe, then a
 * known agent (welcomed, or flagged as an impersonation when its IP is outside
 * the vendor's published ranges), then flagged automation (self-declared bot, a
 * named scanner/library/headless tool, or a browser UA whose headers don't
 * match). A normal visitor returns null or a page view - the common path.
 */
export function observeRequest(input: ObserveInput, ruleset: ForcefieldRuleset): Observation | null {
  const { path, method, userAgent } = input;
  const authenticated = input.authenticated === true;
  const names = new Set(input.headerNames.map((h) => (h ?? "").toLowerCase()));
  const verdict = classifyWebRequest(
    { path, method, userAgent },
    { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents },
  );
  const client = classifyClient(userAgent, input.headerNames, ruleset.toolSignatures);
  // Proof carried by the request itself: a header attack (CVE-2025-29927) or an
  // injection payload in the full target (query included). Ranked right after a
  // decoy trip, and evaluated whatever the UA claims.
  const attack = detectHeaderAttack(input.headerNames, path) ?? detectPayload(input.rawUrl ?? path);
  const native = input.platform ? ruleset.platformPaths?.[input.platform] ?? [] : [];
  const sensitive = matchedSensitive(path, ruleset.sensitivePaths, native);
  const probe =
    sensitive ??
    nestedDotenvProbe(path) ??
    wpPluginAbuseProbe(path, input.rawUrl, authenticated) ??
    updraftCentralProbe(userAgent, input.platform) ??
    (input.platform === "wordpress" && WP_BACKDOOR_TRIGGER.test(input.rawUrl ?? "") ? "wp_backdoor_trigger" : null) ??
    // A Server Action invocation (`next-action` header) from a NON-browser
    // client is someone driving the action endpoint directly - React2Shell
    // (CVE-2025-55182) exploitation keys on exactly this header
    // (https://www.upguard.com/blog/understanding-and-mitigating-cve-2025-55182-react2shell).
    // Report-only, and a weak tell: an authenticated client is not flagged.
    (!authenticated && names.has("next-action") && client.clientType !== "browser" ? "next_server_action" : null);

  // Verify a claimed agent by its vendor's PUBLISHED ranges.
  let verification: AgentVerification | null = null;
  if (verdict.class === "known_agent") {
    verification = verifyAgentByRanges(verdict.matchedAgentId, input.ip, ruleset.verifiedAgentRanges);
  }
  const signedAgent = presentsSignedAgent(names);

  // A NAMED scanner is flagged on any path - proven tradecraft. A scripted HTTP
  // library is too, unless the site attested a verified credential (our own
  // crons and monitors are curl/urllib with a real secret).
  const hostileTool = client.clientType === "scanner" || (client.clientType === "scripted_library" && !authenticated);
  // The WEAKER tells (a headless browser, a header-shape spoof, an otherwise
  // suspicious classification). These fire on every asset a headless page load
  // pulls, so they are suppressed on static sub-resources - see isStaticAsset -
  // and for an authenticated request (our own E2E runs headless, signed in).
  const weakTell =
    !authenticated && (verdict.class === "suspicious" || client.clientType === "headless" || client.headerMismatch);

  let type: ForcefieldEventType | null = null;
  if (verdict.class === "trapped") type = "site.agent_trap_tripped";
  else if (attack) type = "site.agent_payload_attack";
  else if (probe) type = "site.agent_probed_sensitive";
  else if (verdict.class === "known_agent") type = verification === "impersonation" ? "site.agent_flagged" : "site.agent_welcomed";
  else if (hostileTool || (weakTell && !isStaticAsset(path))) type = "site.agent_flagged";
  else if (signedAgent) type = "site.agent_welcomed";

  // Not an agent. If it is a real human page navigation, forward it as a page
  // view so the property reports the SAME analytics as ogiam.com (page views,
  // hourly heatmap, top pages, top countries) - not just agent traffic. Anything
  // else (assets, XHR, non-GET) is a normal non-page request: forward nothing.
  if (!type) {
    if (isHumanPageView(input)) {
      return {
        type: "site.page_viewed",
        path,
        props: {
          site: input.site,
          sig: sessionSig(userAgent, input.country, input.headerNames, input.nowMs),
        },
      };
    }
    return null;
  }

  const props = agentProps(input, ruleset, verdict.matchedAgentId ?? (signedAgent ? "signed_agent" : undefined));
  if (probe) props.probe = probe;
  const probeClass = sensitive ? probeClassOf(sensitive, ruleset.probeClasses) : null;
  if (probeClass) props.probe_class = probeClass;
  if (attack) {
    props.attack = attack;
    if (PAYLOAD_CWE[attack]) props.cwe = PAYLOAD_CWE[attack];
  }
  if (verification) props.agent_verification = verification;
  if (verification === "impersonation" && verdict.matchedAgentId) props.impersonating = verdict.matchedAgentId;
  if (signedAgent) props.signed_agent = true;
  stampAttestation(props, input);
  return { type, path, props };
}

/** What the caller did with the enforcement decision for this request. */
export interface EnforcementOutcome {
  /** The engine proved the request hostile (decideEnforcement().block). */
  wouldBlock: boolean;
  /** The request was ACTUALLY turned away (enforce on, entitled, not withheld). */
  blocked: boolean;
  reasonKind?: string;
  attack?: string;
}

/**
 * Stamp the enforcement outcome on an observation so the stored row says what
 * happened: blocked:true + action "block" + posture "enforce" + reason_kind when
 * the request was turned away, or would_block:true + action "report" when the
 * engine proved it hostile but a gate (watch mode / unlicensed) withheld the
 * block. A blocked request whose observation was null (e.g. an admin-blocked
 * fingerprint on a request with no other tell) still gets a record, so no
 * enforced block is ever invisible on the board. Pure; returns obs unchanged
 * when nothing would have been blocked.
 */
export function withEnforcement(
  obs: Observation | null,
  input: ObserveInput,
  ruleset: ForcefieldRuleset,
  outcome: EnforcementOutcome,
): Observation | null {
  if (!outcome.wouldBlock) return obs;
  let base = obs;
  if (!base || base.type === "site.page_viewed") {
    const verdict = classifyWebRequest(
      { path: input.path, method: input.method, userAgent: input.userAgent },
      { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents },
    );
    base = { type: "site.agent_flagged", path: input.path, props: agentProps(input, ruleset, verdict.matchedAgentId) };
  }
  const props = { ...base.props };
  if (outcome.reasonKind) props.reason_kind = outcome.reasonKind;
  if (outcome.attack && props.attack === undefined) {
    props.attack = outcome.attack;
    if (PAYLOAD_CWE[outcome.attack]) props.cwe = PAYLOAD_CWE[outcome.attack];
  }
  if (outcome.blocked) {
    props.blocked = true;
    props.action = "block";
    props.posture = "enforce";
  } else {
    props.would_block = true;
    props.action = "report";
  }
  stampAttestation(props, input);
  return { ...base, props };
}
