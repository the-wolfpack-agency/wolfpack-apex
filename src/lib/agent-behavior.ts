/**
 * Agent behavior classifier - the spine of "follow the agent" analytics.
 *
 * A single event (one honeypot trip) is a point; a correlated SET of a session's
 * events is a behavior signature, and behavior is far harder to spoof than a
 * User-Agent string. This module is pure: given one session's events + how they
 * were correlated, it fuses the signals into a behavior class and, critically, a
 * CONFIDENCE label that never lets the good/bad line blur silently:
 *
 *   proven   - the session was stitched by a correlation NONCE the actor itself
 *              carried (it engaged a trap or a hidden field only a bot touches).
 *              We KNOW it is automation and we KNOW the events are one actor.
 *   inferred - the session was grouped by a coarse, non-PII fingerprint (UA +
 *              network + time window). Useful, but probabilistic - a careful
 *              adversary can pace itself to look human, so this is a hypothesis,
 *              labeled as one, never presented as proof.
 *
 * No PII in, no PII out: keys are opaque nonces/fingerprints, features are
 * structural. The classifier is deterministic - same session, same verdict.
 */

/** A structural signal observed during a session. Each maps from one or more
 *  recorded events; none carries PII. */
export type AgentSignal =
  | "read_robots" // fetched robots.txt (good crawlers do)
  | "read_sitemap" // fetched sitemap.xml
  | "tripped_decoy" // followed the invisible, robots-disallowed honeypot link
  | "form_honeypot" // filled a hidden form field a human never sees
  | "form_too_fast" // submitted a form faster than a human could type
  | "probed_sensitive" // requested /admin, /.env, /wp-login, /api, etc.
  | "high_rate" // many requests in a short window
  | "identified_agent"; // matched the known-agent allowlist (welcome lane)

export type BehaviorClass =
  | "benign_crawler" // identified and rule-respecting; not our concern, just observed
  | "aggressive_scraper" // ignores the rules, harvests greedily, trips decoys
  | "vuln_scanner" // probes sensitive paths, recon
  | "form_spammer" // targets forms, trips the form honeypot / too-fast submits
  | "suspicious" // automation with weak signals, not enough to classify
  | "unclassified"; // nothing actionable observed

export type Confidence = "proven" | "inferred";

/** How a session's events were tied together. A nonce is deterministic (the
 *  actor carried it); a fingerprint is a probabilistic grouping. */
export type CorrelationKind = "nonce" | "fingerprint";

export interface SessionEvent {
  /** Event type, e.g. "site.agent_trap_tripped". */
  type: string;
  /** Path the event was about. */
  path: string;
  /** ISO timestamp. */
  at: string;
  /** Whether this specific event was tied in by a nonce (proven) vs the coarse
   *  fingerprint (inferred). A session is proven if ANY event is nonce-tied. */
  nonceLinked?: boolean;
  /** The identified agent id, when the event carried one. */
  agent?: string;
}

export interface AgentSessionInput {
  /** Opaque correlation key (a nonce or a fingerprint hash). Never PII. */
  key: string;
  keyKind: CorrelationKind;
  events: readonly SessionEvent[];
}

export interface AgentJourney {
  key: string;
  confidence: Confidence;
  behaviorClass: BehaviorClass;
  signals: AgentSignal[];
  /** Ordered, de-duplicated path the actor took across the surface. */
  path: string[];
  eventCount: number;
  firstAt: string;
  lastAt: string;
  /** One plain sentence a non-expert can read. */
  summary: string;
}

/** Map an event type to the structural signal it represents. Unknown/benign
 *  event types (e.g. plain page views) contribute to the path but not a signal. */
function signalOf(ev: SessionEvent): AgentSignal | null {
  switch (ev.type) {
    case "site.agent_trap_tripped":
      return "tripped_decoy";
    case "site.agent_read_robots":
      return "read_robots";
    case "site.agent_read_sitemap":
      return "read_sitemap";
    case "site.agent_probed_sensitive":
      return "probed_sensitive";
    case "site.agent_form_honeypot":
      return "form_honeypot";
    case "site.agent_form_too_fast":
      return "form_too_fast";
    case "site.agent_high_rate":
      return "high_rate";
    case "site.agent_welcomed":
      return "identified_agent";
    default:
      return null;
  }
}

const HOSTILE: ReadonlySet<AgentSignal> = new Set(["tripped_decoy", "form_honeypot", "probed_sensitive"]);

/** Classify one correlated session into a behavior signature. Deterministic. */
export function classifySession(input: AgentSessionInput): AgentJourney {
  const events = [...input.events].sort((a, b) => a.at.localeCompare(b.at));
  const signals = Array.from(new Set(events.map(signalOf).filter((s): s is AgentSignal => s !== null)));
  const has = (s: AgentSignal) => signals.includes(s);

  // Path: ordered, consecutive-duplicate-collapsed list of paths touched.
  const path: string[] = [];
  for (const ev of events) if (ev.path && ev.path !== path[path.length - 1]) path.push(ev.path);

  // Confidence: proven only when the actor itself carried a correlation nonce
  // OR tripped a signal that a human structurally cannot (a hidden field / an
  // invisible decoy). Everything else is a fingerprint-grouped hypothesis.
  const nonceProven = input.keyKind === "nonce" || events.some((e) => e.nonceLinked);
  const structurallyBot = has("tripped_decoy") || has("form_honeypot");
  const confidence: Confidence = nonceProven || structurallyBot ? "proven" : "inferred";

  const behaviorClass = classify(signals, has);
  const eventCount = events.length;
  const firstAt = events[0]?.at ?? "";
  const lastAt = events[events.length - 1]?.at ?? "";

  return {
    key: input.key,
    confidence,
    behaviorClass,
    signals,
    path,
    eventCount,
    firstAt,
    lastAt,
    summary: summarize(behaviorClass, confidence, signals),
  };
}

function classify(signals: readonly AgentSignal[], has: (s: AgentSignal) => boolean): BehaviorClass {
  // Form-targeted abuse: the form honeypot / too-fast submit is a bright line.
  if (has("form_honeypot") || has("form_too_fast")) return "form_spammer";
  // Recon: probing sensitive paths, especially several.
  if (has("probed_sensitive")) return "vuln_scanner";
  // Greedy harvest: tripped the invisible decoy (ignored the rules).
  if (has("tripped_decoy")) return "aggressive_scraper";
  // Identified + rule-respecting: observed, not our concern.
  if (has("identified_agent") && !signals.some((s) => HOSTILE.has(s))) return "benign_crawler";
  // Some automation signal but nothing decisive.
  if (has("high_rate") || has("read_robots") || has("read_sitemap")) return "suspicious";
  return "unclassified";
}

function summarize(cls: BehaviorClass, conf: Confidence, signals: readonly AgentSignal[]): string {
  const proven = conf === "proven";
  const tail = proven ? "This is confirmed automation." : "Grouped by a coarse fingerprint, so this is a likely match, not confirmed.";
  switch (cls) {
    case "aggressive_scraper":
      return `Followed an invisible trap link and harvested greedily, ignoring the site's rules. ${tail}`;
    case "vuln_scanner":
      return `Probed sensitive paths looking for a way in (${signals.filter((s) => s === "probed_sensitive").length ? "recon" : "recon"}). ${tail}`;
    case "form_spammer":
      return `Targeted a form the way a spam bot does (hidden-field or inhuman-speed submit). ${tail}`;
    case "benign_crawler":
      return `An identified, rule-respecting crawler. Observed for completeness, not a threat.`;
    case "suspicious":
      return `Automation with weak signals, not enough to classify yet. ${tail}`;
    default:
      return `Nothing actionable observed. ${tail}`;
  }
}

/**
 * Group a flat list of correlated events into sessions and classify each. Events
 * are bucketed by their correlation key. A key that came from a nonce is proven;
 * otherwise a fingerprint (inferred). Returns journeys newest-activity first.
 */
export function buildJourneys(
  rows: ReadonlyArray<{ key: string; keyKind: CorrelationKind; type: string; path: string; at: string; nonceLinked?: boolean; agent?: string }>,
): AgentJourney[] {
  const byKey = new Map<string, AgentSessionInput>();
  for (const r of rows) {
    let s = byKey.get(r.key);
    if (!s) {
      s = { key: r.key, keyKind: r.keyKind, events: [] };
      byKey.set(r.key, s);
    }
    // A nonce grouping always wins over a fingerprint grouping for the same key.
    if (r.keyKind === "nonce") (s as { keyKind: CorrelationKind }).keyKind = "nonce";
    (s.events as SessionEvent[]).push({ type: r.type, path: r.path, at: r.at, nonceLinked: r.nonceLinked, agent: r.agent });
  }
  return Array.from(byKey.values())
    .map(classifySession)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
