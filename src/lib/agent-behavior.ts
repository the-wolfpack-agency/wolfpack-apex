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
  | "payload_attack" // sent an active injection payload (SQLi/XSS/traversal/...)
  | "id_enumeration" // walked sequential object IDs (IDOR enumeration)
  | "runaway_loop" // hammered one endpoint many times (resource-exhaustion loop)
  | "identified_agent"; // matched the known-agent allowlist (welcome lane)

export type BehaviorClass =
  | "benign_crawler" // identified and rule-respecting; not our concern, just observed
  | "aggressive_scraper" // ignores the rules, harvests greedily, trips decoys
  | "exploit_attempt" // sent a live injection payload - active exploitation, not just recon
  | "vuln_scanner" // probes sensitive paths, recon
  | "form_spammer" // targets forms, trips the form honeypot / too-fast submits
  | "suspicious" // automation with weak signals, not enough to classify
  | "unclassified"; // nothing actionable observed

export type Confidence = "proven" | "inferred";

/** A novel conclusion drawn from a session that goes beyond the behavior class.
 *  These are the higher-order tells: an agent wearing a good-bot's identity, or
 *  one that read the rules and then broke them on purpose. */
export type JourneyInsight =
  | { kind: "impersonation"; claimedAgent: string; detail: string }
  | { kind: "deliberate_violation"; detail: string }
  | { kind: "payload_attack"; attack: string; detail: string }
  | { kind: "id_enumeration"; detail: string }
  | { kind: "runaway_loop"; detail: string };

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
  /** The attack kind, when this is a payload-attack event (props.attack). */
  attack?: string;
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
  /** Novel conclusions beyond the behavior class (impersonation, deliberate
   *  rule violation). Empty when none apply. */
  insights: JourneyInsight[];
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
    case "site.agent_payload_attack":
      return "payload_attack";
    case "site.agent_welcomed":
      return "identified_agent";
    default:
      return null;
  }
}

const HOSTILE: ReadonlySet<AgentSignal> = new Set(["tripped_decoy", "form_honeypot", "probed_sensitive", "payload_attack"]);

/**
 * Higher-order conclusions from the ORDERED events, beyond the behavior class.
 *  - impersonation: presented a known good-agent identity (welcome lane) AND
 *    behaved hostilely. The real crawler does not probe /admin or trip a decoy,
 *    so this is a spoofed good bot wearing its uniform to evade.
 *  - deliberate_violation: read robots.txt BEFORE it violated the rules (tripped
 *    the decoy / probed). It knew the rules and broke them; ignorance is out.
 */
function deriveInsights(
  events: readonly SessionEvent[],
  signals: readonly AgentSignal[],
  has: (s: AgentSignal) => boolean,
): JourneyInsight[] {
  const out: JourneyInsight[] = [];
  const hostilePresent = signals.some((s) => HOSTILE.has(s));

  if (has("identified_agent") && hostilePresent) {
    const claimed = events.find((e) => signalOf(e) === "identified_agent" && e.agent)?.agent ?? "a known crawler";
    out.push({
      kind: "impersonation",
      claimedAgent: claimed,
      detail: `Presented the identity of ${claimed} (a known good agent) but then behaved hostilely. The real crawler does not do this, so this is a spoofed good bot wearing its uniform to evade filters.`,
    });
  }

  if (has("payload_attack")) {
    const attack = events.find((e) => signalOf(e) === "payload_attack" && e.attack)?.attack ?? "injection";
    out.push({
      kind: "payload_attack",
      attack,
      detail: `Sent a live ${attack.replace(/_/g, " ")} payload in a request. This is active exploitation attempted against the surface, not just a probe for an exposed path.`,
    });
  }

  if (has("id_enumeration")) {
    out.push({
      kind: "id_enumeration",
      detail: "Walked a run of sequential object IDs (e.g. /users/1, /2, /3), the signature of IDOR enumeration: probing for records it should not reach by stepping through identifiers.",
    });
  }

  if (has("runaway_loop")) {
    out.push({
      kind: "runaway_loop",
      detail: "Hit one endpoint many times in a single session, the signature of a runaway loop / resource-exhaustion pattern rather than normal use.",
    });
  }

  if (has("read_robots")) {
    const robotsAt = events.find((e) => e.type === "site.agent_read_robots")?.at;
    const firstHostileAt = events.find((e) => { const g = signalOf(e); return g !== null && HOSTILE.has(g); })?.at;
    if (robotsAt && firstHostileAt && robotsAt <= firstHostileAt) {
      out.push({
        kind: "deliberate_violation",
        detail: "Read the site's rules (robots.txt) first, then violated them. It knew what was disallowed and did it anyway; ignorance is not the explanation.",
      });
    }
  }

  return out;
}

/** IDOR enumeration: >=3 distinct sequential object IDs under one path template
 *  (e.g. /users/1, /users/2, /users/3). Deterministic + pure. */
const ENUM_MIN_IDS = 3;
/** Runaway loop / resource exhaustion: one exact path hit >= this many times. */
const LOOP_MIN_HITS = 8;

function pathTemplate(p: string): { template: string; num: number } | null {
  const m = p.split("?")[0].match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return null;
  return { template: `${m[1]}{n}${m[3]}`, num: Number(m[2]) };
}

/** True when the paths walk >=3 distinct IDs under a shared template. */
export function detectIdEnumeration(paths: readonly string[]): boolean {
  const byTemplate = new Map<string, Set<number>>();
  for (const p of paths) {
    const t = pathTemplate(p);
    if (!t) continue;
    const set = byTemplate.get(t.template) ?? new Set<number>();
    set.add(t.num);
    byTemplate.set(t.template, set);
  }
  for (const ids of byTemplate.values()) if (ids.size >= ENUM_MIN_IDS) return true;
  return false;
}

/** True when one exact path is hit >= LOOP_MIN_HITS times (a runaway loop). */
export function detectRunawayLoop(rawPaths: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const p of rawPaths) {
    const n = (counts.get(p) ?? 0) + 1;
    if (n >= LOOP_MIN_HITS) return true;
    counts.set(p, n);
  }
  return false;
}

/** Classify one correlated session into a behavior signature. Deterministic. */
export function classifySession(input: AgentSessionInput): AgentJourney {
  const events = [...input.events].sort((a, b) => a.at.localeCompare(b.at));
  const signals = Array.from(new Set(events.map(signalOf).filter((s): s is AgentSignal => s !== null)));
  const has = (s: AgentSignal) => signals.includes(s);

  // Path: ordered, consecutive-duplicate-collapsed list of paths touched.
  const path: string[] = [];
  for (const ev of events) if (ev.path && ev.path !== path[path.length - 1]) path.push(ev.path);

  // Derived signals from the request SEQUENCE (not single events): IDOR
  // enumeration walks distinct IDs (visible in the deduped path); a runaway loop
  // repeats one exact path (needs the raw, non-deduped paths).
  const rawPaths = events.map((e) => e.path).filter((p): p is string => !!p);
  if (detectIdEnumeration(path) && !signals.includes("id_enumeration")) signals.push("id_enumeration");
  if (detectRunawayLoop(rawPaths) && !signals.includes("runaway_loop")) signals.push("runaway_loop");

  // Confidence: proven only when the actor itself carried a correlation nonce
  // OR tripped a signal that a human structurally cannot (a hidden field / an
  // invisible decoy). Everything else is a fingerprint-grouped hypothesis.
  const nonceProven = input.keyKind === "nonce" || events.some((e) => e.nonceLinked);
  const structurallyBot = has("tripped_decoy") || has("form_honeypot");
  const confidence: Confidence = nonceProven || structurallyBot ? "proven" : "inferred";

  const behaviorClass = classify(signals, has);
  const insights = deriveInsights(events, signals, has);
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
    insights,
  };
}

function classify(signals: readonly AgentSignal[], has: (s: AgentSignal) => boolean): BehaviorClass {
  // Active exploitation: a live injection payload outranks everything - it is an
  // attack in flight, not recon.
  if (has("payload_attack")) return "exploit_attempt";
  // Form-targeted abuse: the form honeypot / too-fast submit is a bright line.
  if (has("form_honeypot") || has("form_too_fast")) return "form_spammer";
  // Recon: probing sensitive paths, or walking sequential IDs (IDOR enumeration).
  if (has("probed_sensitive") || has("id_enumeration")) return "vuln_scanner";
  // Greedy harvest: tripped the invisible decoy, or hammered one endpoint in a loop.
  if (has("tripped_decoy") || has("runaway_loop")) return "aggressive_scraper";
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
    case "exploit_attempt":
      return `Sent a live injection payload - active exploitation, not just recon. ${tail}`;
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
  rows: ReadonlyArray<{ key: string; keyKind: CorrelationKind; type: string; path: string; at: string; nonceLinked?: boolean; agent?: string; attack?: string }>,
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
    (s.events as SessionEvent[]).push({ type: r.type, path: r.path, at: r.at, nonceLinked: r.nonceLinked, agent: r.agent, attack: r.attack });
  }
  return Array.from(byKey.values())
    .map(classifySession)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
