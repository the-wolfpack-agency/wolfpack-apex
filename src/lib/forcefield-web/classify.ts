/**
 * Forcefield for the Web - deterministic request classifier.
 *
 * Websites now receive visits from AI agents, not only people. Some are helpful
 * (a customer's assistant doing a genuine task); some are hostile (scrapers,
 * abusive automation). Blocking all bots breaks the helpful ones. The goal is
 * the opposite: give known, well-behaved agents a welcome lane, and catch the
 * hostile ones, without punishing normal visitors.
 *
 * This is the pure core, mirroring the agent-side tripwire: same request +
 * config -> same verdict, no I/O. It classifies ONE normalized web request. It
 * is deliberately conservative about strength of signal:
 *   - A DECOY TRIP is high-confidence. Nothing legitimate follows an invisible
 *     honeypot link that robots.txt disallows, so a hit is near-certainly a
 *     scraper ignoring the rules. This is the one signal strong enough to act on.
 *   - A KNOWN AGENT match is a welcome-lane signal from an explicit allowlist.
 *   - "Suspicious" is a WEAK page-level signal (a self-declared bot UA that is
 *     not on the allowlist). It is worth reporting, never worth hard-blocking on
 *     its own - a careful attacker spoofs it and a clumsy good agent trips it.
 * The honest split between what is proof and what is a hint lives right here.
 */

export type WebClass = "known_agent" | "trapped" | "suspicious" | "normal";

/** A normalized inbound web request - only the fields the classifier reads. */
export interface WebRequest {
  /** URL pathname, e.g. "/pricing" or "/_ff/trap-x". Compared exactly to traps. */
  path: string;
  method: string;
  /** The User-Agent header, lowercased by the caller or here. */
  userAgent: string;
}

/** A known, identified good agent that earns the welcome lane. */
export interface KnownAgent {
  id: string;
  /** A substring matched (case-insensitively) against the User-Agent. */
  uaMatch: string;
}

/** The site's Forcefield configuration - decoys seeded and agents welcomed. */
export interface SiteForcefieldConfig {
  /** Invisible honeypot paths a human never sees and a good agent never follows. */
  trapPaths: readonly string[];
  /** Allowlist of known good agents. */
  knownAgents: readonly KnownAgent[];
}

export interface WebVerdict {
  class: WebClass;
  reason: string;
  /** Set when class is "known_agent". */
  matchedAgentId?: string;
  /** Set when class is "trapped". */
  matchedTrapPath?: string;
  /** Strength of the signal. "high" is act-worthy (a decoy trip); "info" is a
   *  weak hint worth recording only; "none" is a normal or welcomed request. */
  signal: "none" | "info" | "high";
}

/** Self-declared bot markers. Presence alone is only a weak hint. */
const BOT_UA_MARKERS = ["bot", "crawler", "spider", "scraper", "crawl", "slurp"];

function norm(s: string): string {
  return (s ?? "").toLowerCase();
}

/**
 * Classify one request against the site config. Deterministic and ordered
 * most-specific first, so a decoy trip always wins over a UA guess.
 */
export function classifyWebRequest(req: WebRequest, config: SiteForcefieldConfig): WebVerdict {
  const path = req.path ?? "";
  const ua = norm(req.userAgent);

  // 1. Decoy trip - the one high-confidence signal. Exact path match.
  const trap = config.trapPaths.find((p) => p === path);
  if (trap) {
    return {
      class: "trapped",
      reason: "followed an invisible honeypot link that robots.txt disallows",
      matchedTrapPath: trap,
      signal: "high",
    };
  }

  // 2. Known, identified good agent - the welcome lane.
  const known = config.knownAgents.find((a) => a.uaMatch && ua.includes(norm(a.uaMatch)));
  if (known) {
    return {
      class: "known_agent",
      reason: `matched the allowlisted agent "${known.id}"`,
      matchedAgentId: known.id,
      signal: "none",
    };
  }

  // 3. A self-declared bot not on the allowlist - a weak hint, report only.
  if (BOT_UA_MARKERS.some((m) => ua.includes(m))) {
    return {
      class: "suspicious",
      reason: "self-declared automation not on the allowlist (weak page-level signal, report only)",
      signal: "info",
    };
  }

  // 4. Everything else - a normal visitor or an undeclared client.
  return { class: "normal", reason: "no decoy touched, no bot signal", signal: "none" };
}
