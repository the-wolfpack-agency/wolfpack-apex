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
 *   2. ATTACK TOOL  - its User-Agent is a named scanner/exploit tool (sqlmap,
 *                     nikto, nmap, nuclei, ...).
 *   3. PAYLOAD      - the request itself carries an injection payload
 *                     (path traversal / SQLi / XSS / open-redirect).
 *   4. BLOCKED FP   - it matches a fingerprint a human explicitly blocked from
 *                     the board, distributed via the central ruleset.
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
import { classifyClient } from "./fingerprint";
import type { ForcefieldRuleset } from "./ruleset";

export type BlockReasonKind = "decoy" | "attack_tool" | "payload" | "blocked_fingerprint";

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
}

const ALLOW: EnforcementDecision = { block: false, reason: "no proven-hostile signal" };

/** Injection-payload signatures. Each is something a legitimate request never
 *  contains, so a match is high-confidence hostile and safe to turn away. Kept
 *  deliberately tight (precision over recall) - a missed attack is still caught
 *  by monitoring, but a false block hits a real user. */
const PAYLOAD_SIGNATURES: ReadonlyArray<{ attack: string; patterns: readonly RegExp[] }> = [
  {
    attack: "path_traversal",
    patterns: [/\.\.[/\\]/, /%2e%2e[/\\%]/i, /\/etc\/passwd/i, /\/proc\/self\//i, /php:\/\/filter/i, /dompdf\.php/i, /eval-stdin\.php/i],
  },
  {
    attack: "sql_injection",
    patterns: [/union\s+select/i, /\bor\s+1\s*=\s*1\b/i, /'\s*or\s*'1'\s*=\s*'1/i, /\bsleep\s*\(/i, /\bbenchmark\s*\(/i, /information_schema/i, /waitfor\s+delay/i],
  },
  {
    attack: "xss",
    patterns: [/<script[\s>]/i, /%3cscript/i, /javascript:/i, /\bonerror\s*=/i, /\bonload\s*=/i, /<img[^>]+src\s*=/i],
  },
  {
    attack: "open_redirect",
    patterns: [/[?&](?:redirect|redirect_uri|url|next|goto|return|returnurl|dest|destination)=(?:https?:)?%2f%2f/i, /[?&](?:redirect|redirect_uri|url|next|goto|return|returnurl|dest|destination)=(?:https?:)?\/\//i, /bitrix\/rk\.php/i],
  },
];

/** Scan the request target for an injection payload; returns the attack family
 *  or null. Checks both the raw (encoded) and decoded forms so an encoded
 *  payload can't slip past a decoded-only pattern and vice versa. */
export function detectPayload(rawUrl: string): string | null {
  const raw = rawUrl ?? "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* malformed percent-encoding: fall back to the raw form only. */
  }
  for (const { attack, patterns } of PAYLOAD_SIGNATURES) {
    if (patterns.some((re) => re.test(raw) || re.test(decoded))) return attack;
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
  opts: { blockedFingerprints?: readonly string[] } = {},
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
    // A welcomed, allowlisted agent is never blocked - the welcome lane wins over
    // every heuristic below (a good crawler that happens to look scripted stays in).
    if (verdict.class === "known_agent") return ALLOW;

    // 2. A named attack/scanner tool in the User-Agent.
    const client = classifyClient(input.userAgent, input.headerNames, ruleset.toolSignatures);
    if (client.clientType === "scanner") {
      return { block: true, reasonKind: "attack_tool", reason: `named attack tool: ${client.tool ?? "scanner"}` };
    }

    // 3. A live injection payload in the request target.
    const attack = detectPayload(input.rawUrl ?? input.path);
    if (attack) {
      return { block: true, reasonKind: "payload", reason: `injection payload: ${attack}`, attack };
    }

    // 4. A fingerprint a human explicitly blocked from the board.
    if (input.fingerprint && opts.blockedFingerprints && opts.blockedFingerprints.includes(input.fingerprint)) {
      return { block: true, reasonKind: "blocked_fingerprint", reason: "operator fingerprint blocked by an administrator" };
    }

    return ALLOW;
  } catch {
    return ALLOW; // fail-open: enforcement must never break the site.
  }
}
