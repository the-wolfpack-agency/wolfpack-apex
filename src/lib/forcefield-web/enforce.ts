/**
 * Forcefield for the Web - ENFORCEMENT: the deterministic block decision.
 *
 * Monitoring watches; enforcement acts. This module answers one question for a
 * single request: should the edge turn it away RIGHT NOW? It is the graduation
 * from watch-first to protect described in posture.ts, and it is deliberately
 * conservative: it blocks ONLY proven-hostile requests - things a real visitor
 * or a well-behaved agent never does - so turning enforcement on can neither
 * blank the site nor lock out a customer.
 *
 * A request is blocked when, and only when:
 *   1. DECOY TRIP   - it hit an invisible honeypot path a person can't see.
 *   2. PAYLOAD      - the request itself carries an injection payload (path
 *                     traversal / SQLi / XSS / PHP-CGI / ...) or a header attack
 *                     (Next.js middleware bypass). Applies whatever the UA says.
 *   3. ATTACK TOOL  - its User-Agent is a named scanner/exploit tool (sqlmap,
 *                     nikto, nmap, nuclei, ...).
 *   4. BLOCKED FP   - it matches a fingerprint a human explicitly blocked from
 *                     the board, distributed via the central ruleset.
 *   5. SITE POLICY  - it is (or claims to be) an AI training crawler the site
 *                     chose to turn away (opts.blockedAgents).
 * 3 and 4 are skipped for a welcomed agent (unless proven an impersonator) and
 * for a site-attested authenticated request; 1 and 2 never are.
 * Everything else - a normal visitor, a welcomed crawler, a weak "suspicious"
 * hint, a bare recon probe - is NEVER blocked here; it stays report-only. A
 * page-level hint is not proof, and the safe direction to be wrong in is to let
 * a request through and record it, not to turn a real user away.
 *
 * PURE + EDGE-SAFE: no I/O, deterministic (same input + ruleset -> same verdict).
 * The caller decides whether to act on `block` (gated by FORCEFIELD_ENFORCE and
 * the site posture); this module only computes the honest verdict.
 */
import { classifyWebRequest } from "./classify";
import { classifyClient, operatorFingerprint } from "./fingerprint";
import { verifyAgentByRanges } from "./hosting";
import type { ForcefieldRuleset } from "./ruleset";

/** "intent" is never returned by decideEnforcement: it is the sticky block the
 *  intent step-up applies to a PROVEN session's follow-on requests (intent.ts). */
/** "agent_policy": the SITE chose to turn this agent away (an AI training crawler
 *  on its block list, agent-policy.ts). Not hostile, so never intent proof. */
export type BlockReasonKind = "decoy" | "attack_tool" | "payload" | "blocked_fingerprint" | "intent" | "agent_policy";

export interface EnforcementDecision {
  /** True only when the request is proven-hostile and should be turned away. */
  block: boolean;
  /** Which rule fired (absent when not blocked). */
  reasonKind?: BlockReasonKind;
  /** Human-readable reason for the audit trail + the block response body. */
  reason: string;
  /** The attack family when reasonKind === "payload" (path_traversal, etc.). */
  attack?: string;
}

export interface EnforceInput {
  path: string;
  /** The full request target (pathname + query) so a payload in the query is
   *  seen too. Falls back to `path` when absent. */
  rawUrl?: string;
  method: string;
  userAgent: string;
  /** Lowercased list of the request's header names (for the spoof/tool checks). */
  headerNames: readonly string[];
  /** A stable per-request fingerprint the caller computed, matched against the
   *  ruleset's blocked list. Absent -> the fingerprint rule simply never fires. */
  fingerprint?: string;
  /** SITE-ATTESTED verified session / service credential / synthetic monitor.
   *  An authenticated request is never turned away by the operator-fingerprint
   *  or attack-tool rules (our own monitors and DAST present credentials); it is
   *  STILL blocked by a decoy trip, a payload or a header attack. */
  authenticated?: boolean;
  /** Client IP, used only to verify a claimed crawler against its vendor's
   *  published ranges (an impersonator loses the welcome lane). Never stored. */
  ip?: string;
  /** A body-marker attack family an adapter THAT CAN SEE THE BODY already proved
   *  from the request body (body-inspect.ts: "php2shell" / "react2shell"). This
   *  module never reads bodies itself; it trusts a label the adapter computed
   *  with the same pure engine and treats it as a payload block. Absent on the
   *  Next middleware path, which has no body. Optional. */
  bodyAttack?: string;
}

const ALLOW: EnforcementDecision = { block: false, reason: "no proven-hostile signal" };

/** Injection-payload signatures. Each is something a legitimate request never
 *  contains, so a match is high-confidence hostile and safe to turn away. Kept
 *  deliberately tight (precision over recall) - a missed attack is still caught
 *  by monitoring, but a false block hits a real user. */
// Whitespace as it can appear in a URL: a real space, OR its encoded forms
// (%20, +, tab/newline). Baked INTO the SQL patterns so a payload matches
// whether or not the edge runtime decoded the query - "UNION%20SELECT" and
// "UNION SELECT" both hit, no reliance on decodeURIComponent landing.
const WS = "(?:\\s|%20|%09|%0a|%0d|\\+)";
const PAYLOAD_SIGNATURES: ReadonlyArray<{ attack: string; patterns: readonly RegExp[]; except?: RegExp }> = [
  {
    // XXE (CWE-611): an XML external-entity declaration. Runs FIRST: an XXE
    // payload usually targets /etc/passwd and would otherwise be classed as
    // traversal. Ported from ogiam.com's payload engine so client sites get the
    // same coverage (one engine, not two).
    attack: "xxe",
    patterns: [/<!entity\b/i, /<!doctype[^>]*\[/i, /<!doctype[^>]+\bsystem\b/i, /\bsystem\s+["']?(?:file|php|expect):/i],
  },
  {
    attack: "path_traversal",
    patterns: [/\.\.[/\\]/, /%2e%2e[/\\%]/i, /\/etc\/passwd/i, /\/proc\/self\//i, /php:\/\/filter/i, /dompdf\.php/i, /eval-stdin\.php/i],
  },
  {
    attack: "sql_injection",
    patterns: [
      new RegExp(`union${WS}+select`, "i"),
      new RegExp(`\\bor${WS}+1${WS}*=${WS}*1\\b`, "i"),
      new RegExp(`'${WS}*or${WS}*'1'${WS}*=${WS}*'1`, "i"),
      /\bsleep\s*\(/i, /\bbenchmark\s*\(/i, /information_schema/i,
      new RegExp(`waitfor${WS}+delay`, "i"),
    ],
  },
  {
    attack: "xss",
    patterns: [/<script[\s>]/i, /%3cscript/i, /javascript:/i, /\bonerror\s*=/i, /\bonload\s*=/i, /<img[^>]+src\s*=/i],
  },
  {
    attack: "open_redirect",
    patterns: [/[?&](?:redirect|redirect_uri|url|next|goto|return|returnurl|dest|destination)=(?:https?:)?%2f%2f/i, /[?&](?:redirect|redirect_uri|url|next|goto|return|returnurl|dest|destination)=(?:https?:)?\/\//i, /bitrix\/rk\.php/i],
    // The Next.js image optimizer's `url=` is an image FETCH target, not a
    // redirect: a real browser requests /_next/image?url=https://cdn/... for every
    // remote image, and this rule used to flag (and in enforce, block) those.
    // Hostile /_next/image targets are covered by the ssrf family instead.
    except: /^\/_next\/image(?:\?|$)/i,
  },
  {
    // Shell command injection. Kept deliberately tight to avoid colliding with a
    // legitimate field value that happens to contain a separator (e.g. sort=a|id):
    // a shell metacharacter must be immediately followed by a NETWORK/SHELL command
    // name, or a $()/backtick substitution, or a read of a system file.
    attack: "command_injection",
    patterns: [
      /[;&`]\s*(?:whoami|curl|wget|nc|ncat|bash|powershell|nslookup|dig|chmod|chown|mkfifo|telnet|\/bin\/(?:ba)?sh)\b/i,
      /\|\s*(?:whoami|curl|wget|nc|ncat|bash|nslookup|dig|sh)\b/i,
      /\$\((?:whoami|id|cat|curl|wget|uname|hostname|nc)\b/i,
      /%0a\s*(?:whoami|curl|wget|nc|bash|cat|chmod)\b/i,
      /\b(?:cat|head|less|tail)\s+\/etc\/(?:passwd|shadow)\b/i,
    ],
  },
  {
    // Server-side template injection. Tight: an arithmetic probe ({{7*7}}, ${7*7},
    // #{7*7}) or a known sandbox-escape token, not any brace pair (a real route
    // never carries these in its URL).
    attack: "ssti",
    patterns: [
      /\{\{\s*\d+\s*[*]\s*\d+\s*\}\}/,
      /[$#]\{\s*\d+\s*[*]\s*\d+\s*\}/,
      /\{\{.*(?:config|self|request|__class__|__globals__|__subclasses__|cycler|lipsum|freemarker|runtime)\b.*\}\}/i,
      /<%=?[^%]*(?:system|exec|`|Runtime|ProcessBuilder)[^%]*%>/i,
    ],
  },
  {
    // Log4Shell / JNDI lookup injection. Unambiguous: no legitimate request carries
    // a ${jndi:...} lookup. Also catches the common ${lower:}/${env:} obfuscation.
    attack: "log4shell",
    patterns: [
      /\$\{jndi:(?:ldap|ldaps|rmi|dns|iiop|nis|corba)s?:\/\//i,
      /\$\{(?:lower|upper|env|sys|date):[^}]*jndi/i,
    ],
  },
  {
    // CRLF / HTTP response header injection: an encoded newline followed by a
    // response header name is an attempt to split the response / set a header.
    attack: "crlf_injection",
    patterns: [/(?:%0d%0a|%0a|%0d|\r\n|\n)(?:%20|\s)*(?:set-cookie|location|content-length|content-type|refresh|x-)[\w-]*\s*(?::|%3a)/i],
  },
  {
    // NoSQL operator injection: a Mongo-style query operator smuggled through the
    // query string ([$ne], {"$where":...}) - a real client never sends these.
    attack: "nosql_injection",
    patterns: [
      /\[\$(?:ne|gt|gte|lt|lte|regex|where|in|nin|or|and|exists|not|elemMatch)\]/i,
      /["']?\$where["']?\s*(?::|=)/i,
      /\{\s*["']?\$(?:ne|gt|gte|lt|lte|regex|where|in|nin)["']?\s*:/i,
    ],
  },
  {
    // SSRF: a URL-ish parameter pointing at a cloud metadata endpoint, a loopback/
    // link-local address, or a non-http internal scheme (file/gopher/dict/ftp).
    // Scoped to params that actually carry a fetch target to avoid false positives.
    attack: "ssrf",
    patterns: [
      /[?&](?:url|uri|dest|destination|target|callback|webhook|next|image|img|src|source|proxy|fetch|load|host|domain|feed|endpoint|u|q)=[^&]*?(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|fd00:ec2|169\.254\.170\.2)/i,
      /[?&][^=&]*=[^&]*?\b(?:file|gopher|dict|ftp|ldap|tftp):(?:%2f%2f|\/\/)/i,
      // Next.js image optimizer as an SSRF pivot: /_next/image?url= aimed at a
      // loopback, link-local, private-range or *.internal host. A real page only
      // ever asks it for a relative path or an allowlisted public CDN. Source:
      // GHSA-rvpw-p7vw-wj3m / CVE-2025-6087 (https://osv.dev/vulnerability/GHSA-rvpw-p7vw-wj3m)
      // and the remotePatterns misconfiguration class
      // (https://www.intigriti.com/researchers/blog/hacking-tools/ssrf-vulnerabilities-in-nextjs-targets).
      /\/_next\/image\?(?:[^#]*&)?url=(?:https?:)?\/\/(?:localhost|127\.|0\.0\.0\.0|0x7f|\[?::1\]?|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.100\.100\.200|metadata\.google\.internal|[a-z0-9.-]+\.internal(?:[:/&]|$))/i,
      // Out-of-band (OAST/interactsh) callback hosts smuggled into a parameter,
      // the signature of blind-SSRF tooling. Source: GreyNoise, "Threat actors
      // actively targeting LLMs" IOC list (https://www.greynoise.io/blog/threat-actors-actively-targeting-llms).
      /[?&][^=&]*=[^&]*?\.oast\.(?:live|me|online|pro|fun|site|today)\b/i,
    ],
  },
  {
    // PHP-CGI argument injection: a query string that php-cgi parses as -d INI
    // switches. CVE-2012-1823 used a plain "-d"; CVE-2024-4577 bypasses the fix
    // with the Windows best-fit soft hyphen (%AD -> "-"). The watchTowr PoC sends
    // "?%ADd+allow_url_include%3d1+-d+auto_prepend_file%3dphp://input"
    // (https://github.com/watchtowrlabs/CVE-2024-4577, DEVCORE advisory via
    // https://www.tenable.com/blog/cve-2024-4577-proof-of-concept-available-for-php-cgi-argument-injection-vulnerability).
    // Matched on the INI directive being SET, which no legitimate URL does.
    // PHP2Shell (CVE-2026-109618 / CVE-2026-109619) is NOT this URL-target rule:
    // its indicators are multipart/urlencoded BODY markers. This URL engine never
    // reads bodies; an adapter that can (the Cloudflare Worker) runs the shared
    // body analyzer (body-inspect.ts) and passes the verdict in as `bodyAttack`,
    // handled below. See https://securitylabs.datadoghq.com/articles/php2shell-critical-vulnerabilities-in-php/.
    attack: "php_cgi_injection",
    patterns: [
      /(?:%ad|\u00ad|(?:^|[?&+\s])-)d(?:\+|\s|%20)+(?:allow_url_include|auto_prepend_file|auto_append_file|disable_functions|open_basedir|safe_mode)(?:\s*=|%3d)/i,
      /\ballow_url_include(?:\s*=|%3d)\s*(?:1|on|true)\b/i,
      /\bauto_(?:prepend|append)_file(?:\s*=|%3d)\s*(?:php|data)(?::|%3a)/i,
    ],
  },
  {
    // Unrestricted upload (CWE-434): a filename parameter carrying a server-side
    // executable extension. A real upload form posts the file in the body; a
    // filename= in the request TARGET with .php/.jsp/... is a webshell drop probe.
    attack: "unrestricted_upload",
    patterns: [/\bfilename\s*=\s*["']?[^"'&]+\.(?:php\d?|phtml|phar|jsp|jspx|asp|aspx|ashx|cgi|shtml|war)\b/i],
  },
  {
    // Prompt injection (CWE-1427) aimed at an AI feature behind the site (a
    // search box or chat endpoint that feeds a model). BLOCK tier only: an
    // instruction-override phrase with a prompt/rule target, a system-prompt
    // exfiltration ask, or a chat-template delimiter. Deliberately NOT here: bare
    // tokens like "jailbreak" or "DAN mode", which a person can legitimately
    // search for on a blog; ogiam.com's engine blocks those, client sites must not.
    attack: "prompt_injection",
    patterns: [
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|the\s+|your\s+|any\s+)?(?:previous|prior|above|earlier|initial|system)\s+(?:instructions?|prompts?|messages?|context|rules?|directions?)\b/i,
      /\b(?:reveal|print|show|repeat|leak|expose|output)\s+(?:your\s+|the\s+)?(?:system\s*prompt|initial\s+(?:instructions?|prompt)|hidden\s+prompt)\b/i,
      /<\|(?:im_start|im_end|system|endoftext)\|>/i,
      /\[\/?(?:inst|sys)\]/i,
    ],
  },
];

/** The CWE each payload / header attack family maps to, so a recorded block
 *  carries a standard identifier (feeds the threat-coverage matrix). Kept total
 *  by a test: every family in PAYLOAD_SIGNATURES and every header attack has an
 *  entry. */
export const PAYLOAD_CWE: Readonly<Record<string, string>> = {
  xxe: "CWE-611",
  path_traversal: "CWE-22",
  sql_injection: "CWE-89",
  xss: "CWE-79",
  open_redirect: "CWE-601",
  command_injection: "CWE-78",
  ssti: "CWE-1336",
  log4shell: "CWE-917",
  crlf_injection: "CWE-113",
  nosql_injection: "CWE-943",
  ssrf: "CWE-918",
  php_cgi_injection: "CWE-88",
  unrestricted_upload: "CWE-434",
  prompt_injection: "CWE-1427",
  nextjs_middleware_bypass: "CWE-288",
  // Body-marker families proved by an adapter (body-inspect.ts). php2shell is
  // PHP's multipart/urlencoded parser corrupting memory during request start-up
  // (CVE-2026-109618/109619); react2shell is RSC Flight deserialization reaching
  // the Function constructor via the prototype chain (CVE-2025-55182).
  php2shell: "CWE-787",
  react2shell: "CWE-502",
};

/** The attack families the payload engine can return, in match order. */
export const PAYLOAD_FAMILIES: readonly string[] = PAYLOAD_SIGNATURES.map((p) => p.attack);

/**
 * The control-plane endpoints every Forcefield edge calls FROM its own Next.js
 * middleware (see tenant-quickstart.ts). Next sets `x-middleware-subrequest` on
 * fetches made from middleware, so these arrive carrying it legitimately: about
 * 6,700 a day were reported as CVE-2025-29927 attempts against the core itself.
 * None of these routes relies on middleware for auth (each checks the tenant
 * token in its handler), so the header buys an attacker nothing here.
 */
export const FORCEFIELD_CONTROL_PLANE_PATHS: ReadonlySet<string> = new Set([
  "/api/site-analytics/ingest",
  "/api/forcefield/ruleset",
  "/api/forcefield/observe",
  // a site's middleware reads its own agent policy here (monitor.ts sitePolicyUrl)
  "/api/forcefield/site-policy",
  // a site mints and checks its fake sign-ins here (canary-login.ts in the engine)
  "/api/forcefield/canary/mint",
  "/api/forcefield/canary/check",
  // a site forwards its visitors' page integrity reports here (integrity.ts)
  "/api/forcefield/integrity",
]);

/**
 * Header-borne attacks, detected from header NAMES alone (values are never read
 * or stored, so this stays non-PII and works with what every adapter forwards).
 *
 * nextjs_middleware_bypass - CVE-2025-29927: a client-sent
 * `x-middleware-subrequest` header made Next.js skip middleware entirely (auth
 * bypass). Next.js sets it only on its OWN internal subrequests (and Next 16 no
 * longer uses it at all), so an inbound request from outside carrying it is an
 * exploitation attempt. The vendor's own mitigation is to drop every external
 * request that carries it: https://github.com/advisories/GHSA-f82v-jwr5-mffw
 */
export function detectHeaderAttack(headerNames: readonly string[], path?: string): string | null {
  if (path !== undefined && FORCEFIELD_CONTROL_PLANE_PATHS.has(path)) return null;
  for (const h of headerNames) {
    if ((h ?? "").toLowerCase() === "x-middleware-subrequest") return "nextjs_middleware_bypass";
  }
  return null;
}

/** Scan the request target for an injection payload; returns the attack family
 *  or null. Matches against SEVERAL normalized forms so a payload can't hide in
 *  encoding: the raw string, a full percent-decode, and a form where only the
 *  common encoded-whitespace sequences (%20, +, tab/newline) are turned into
 *  spaces. The last one matters because some edge runtimes hand middleware a URL
 *  where decodeURIComponent does not fully apply, so "UNION%20SELECT" would slip
 *  past a decoded-only check - the whitespace-normalized form still catches it. */
export function detectPayload(rawUrl: string): string | null {
  const raw = rawUrl ?? "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* malformed percent-encoding: fall back to the other forms. */
  }
  // Encoded-whitespace -> space, applied to BOTH raw and decoded so keyword
  // pairs separated by %20/+/%09/%0a/%0d are seen as separated by a space.
  const dws = (s: string): string => s.replace(/%20|%09|%0a|%0d|\+/gi, " ");
  const forms = [raw, decoded, dws(raw), dws(decoded)];
  for (const { attack, patterns, except } of PAYLOAD_SIGNATURES) {
    if (except && except.test(raw)) continue;
    if (patterns.some((re) => forms.some((f) => re.test(f)))) return attack;
  }
  return null;
}

/**
 * The block decision. Ordered by strength so the recorded reason is the most
 * specific one. Never throws; anything unexpected falls through to ALLOW
 * (fail-open) so enforcement can never itself take a site down.
 */
export function decideEnforcement(
  input: EnforceInput,
  ruleset: ForcefieldRuleset,
  opts: { blockedFingerprints?: readonly string[]; blockedAgents?: readonly string[] } = {},
): EnforcementDecision {
  try {
    // 1. Decoy trip - the single highest-confidence bot signal.
    const verdict = classifyWebRequest(
      { path: input.path, method: input.method, userAgent: input.userAgent },
      { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents },
    );
    if (verdict.class === "trapped") {
      return { block: true, reasonKind: "decoy", reason: `decoy trip: ${verdict.matchedTrapPath ?? input.path}` };
    }

    // 2. Proof carried by the REQUEST ITSELF - a header attack or an injection
    //    payload. Checked BEFORE the welcome lane: a User-Agent is a free-text
    //    claim, so letting "Googlebot" in the UA exempt a request from payload
    //    checks meant any attacker could send SQLi unchallenged by spoofing it.
    const headerAttack = detectHeaderAttack(input.headerNames, input.path);
    if (headerAttack) {
      return { block: true, reasonKind: "payload", reason: `header attack: ${headerAttack}`, attack: headerAttack };
    }
    const attack = detectPayload(input.rawUrl ?? input.path);
    if (attack) {
      return { block: true, reasonKind: "payload", reason: `injection payload: ${attack}`, attack };
    }
    // A body-marker attack an adapter already proved from the request body
    // (body-inspect.ts). Ranked with the other request-carried proof: evaluated
    // whatever the UA claims, never exempted by the welcome lane below.
    if (input.bodyAttack) {
      return { block: true, reasonKind: "payload", reason: `body payload: ${input.bodyAttack}`, attack: input.bodyAttack };
    }

    // 3. The welcome lane - an allowlisted agent skips only the CLIENT-identity
    //    rules below (a good crawler that looks scripted stays in). Never for a
    //    PROVEN impersonation: a UA claiming an agent whose vendor publishes
    //    ranges, from an IP outside them.
    if (verdict.class === "known_agent") {
      // The site's own choice comes first: an agent it turned away is turned away
      // whether it is the real crawler or someone claiming to be it.
      if (verdict.matchedAgentId && opts.blockedAgents?.includes(verdict.matchedAgentId)) {
        return { block: true, reasonKind: "agent_policy", reason: `site policy: ${verdict.matchedAgentId} is not allowed on this site` };
      }
      const v = verifyAgentByRanges(verdict.matchedAgentId, input.ip, ruleset.verifiedAgentRanges);
      if (v !== "impersonation") return ALLOW;
    }

    // An authenticated request (verified session, service credential, synthetic
    // monitor) is never turned away by the client-identity rules: those exist to
    // stop anonymous tooling, and our own monitors / DAST present credentials.
    if (input.authenticated === true) return ALLOW;

    // 4. A named attack/scanner tool in the User-Agent.
    const client = classifyClient(input.userAgent, input.headerNames, ruleset.toolSignatures);
    if (client.clientType === "scanner") {
      return { block: true, reasonKind: "attack_tool", reason: `named attack tool: ${client.tool ?? "scanner"}` };
    }

    // 5. A fingerprint a human explicitly blocked from the board. The fingerprint
    //    binds the header shape to the client's TOOL, so a match is that operator's
    //    exact tooling, not just any client with the same header shape. Computed
    //    here from the same inputs observe.ts stamps on events, so a stored block
    //    lines up with a live request. SAFETY GATE: still only acts on a NON-
    //    browser client - a real person's browser is never turned away even if its
    //    header shape somehow collided.
    const fp = input.fingerprint ?? operatorFingerprint(input.headerNames, client.tool, client.clientType);
    if (
      opts.blockedFingerprints &&
      opts.blockedFingerprints.includes(fp) &&
      client.clientType !== "browser"
    ) {
      return { block: true, reasonKind: "blocked_fingerprint", reason: "operator fingerprint blocked by an administrator" };
    }

    return ALLOW;
  } catch {
    return ALLOW; // fail-open: enforcement must never break the site.
  }
}
