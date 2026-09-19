/**
 * Agent profile - turn one reconstructed journey into a granular, HONEST
 * evidence card for the Site Analytics UI.
 *
 * The journeys list answers "what did this actor do"; the profile answers "how
 * is it built, what is it equipped with, and why do we believe the verdict".
 * Everything here is DERIVED from the journey we already have (no new data), and
 * it reuses the shared engine (analyzeToolComposition, operatorKeyFor, the same
 * DISCLAIMER) so a profile can never drift from a probe/harness dossier.
 *
 * THE HONESTY RAIL, KEPT. Live web traffic exposes PROCESSES (it read robots, it
 * probed sensitive paths, it tripped the decoy) but not an agent's internal tool
 * menu, so the tool read is deliberately thin and says so: only what an HTTP
 * exchange proves. The proven-vs-inferred line and the "not a real-world
 * identity" disclaimer carry through unchanged. Nothing is invented.
 */

import type { AgentJourney, AgentSignal, JourneyInsight } from "@/lib/agent-behavior";
import { analyzeToolComposition, type ToolCompositionReport, type PolicyCategory } from "@/lib/agent-tool-composition";
import { operatorKeyFor, DISCLAIMER } from "@/lib/agent-dossier";
import type { ScaffoldingSignature } from "@/lib/agent-probe";

/** One observed behavior, explained for a non-expert. `hostile` marks the ones
 *  a legitimate visitor never does. */
export interface ObservedProcess {
  signal: AgentSignal;
  label: string;
  meaning: string;
  hostile: boolean;
}

const PROCESS_GLOSSARY: Record<AgentSignal, { label: string; meaning: string; hostile: boolean }> = {
  read_robots: { label: "Read robots.txt", meaning: "Fetched the site's crawl rules, the way a well-behaved crawler does.", hostile: false },
  read_sitemap: { label: "Read sitemap.xml", meaning: "Pulled the sitemap to enumerate pages.", hostile: false },
  identified_agent: { label: "Identified crawler", meaning: "Matched a known, allowlisted crawler (the welcome lane).", hostile: false },
  high_rate: { label: "High request rate", meaning: "Sent many requests in a short window, faster than a person browses.", hostile: false },
  tripped_decoy: { label: "Tripped the decoy", meaning: "Followed an invisible, robots-disallowed link a person cannot see. Structural proof of automation ignoring the rules.", hostile: true },
  probed_sensitive: { label: "Probed sensitive paths", meaning: "Requested paths like /admin or /.env that are not linked anywhere. Recon by guessing, not browsing.", hostile: true },
  form_honeypot: { label: "Filled a hidden field", meaning: "Submitted a form with a honeypot field only a bot fills. Structural proof of automation.", hostile: true },
  form_too_fast: { label: "Submitted inhumanly fast", meaning: "Completed a form faster than a human could type it.", hostile: true },
  payload_attack: { label: "Sent an injection payload", meaning: "Sent a live injection payload (SQLi / XSS / traversal / ...) in a request. Active exploitation, not just a probe.", hostile: true },
};

export interface AgentProfileScaffolding {
  readsRobotsFirst: boolean;
  probedSensitive: boolean;
  /** Best-effort from observed paths. On live traffic we cannot always tell a
   *  followed link from a guessed path, so this is labeled by what IS provable. */
  pathDiscovery: ScaffoldingSignature["pathDiscovery"];
  requestCount: number;
  /** Seconds between first and last observed request in the session. */
  spanSeconds: number;
  /** What the above is and is not - shown so the read is never over-trusted. */
  observability: string;
}

export interface AgentProfile {
  /** Durable, non-PII behavioral fingerprint (scaffolding + observed toolset).
   *  Coarse on live traffic; a bucket, not an identity. */
  operatorKey: string;
  /** The per-session correlation key we grouped by (a nonce or a coarse sig). */
  correlationKey: string;
  verdict: {
    confidence: "proven" | "inferred";
    /** The specific reason for the verdict, in one sentence. */
    why: string;
  };
  processes: ObservedProcess[];
  scaffolding: AgentProfileScaffolding;
  /** What an HTTP exchange proves about tooling. Thin by design on live traffic. */
  toolComposition: ToolCompositionReport;
  policies: PolicyCategory[];
  timeline: { firstAt: string; lastAt: string; spanSeconds: number; eventCount: number };
  disclaimer: string;
  /** Novel conclusions carried from the journey (impersonation, deliberate rule violation). */
  insights: JourneyInsight[];
}

function spanSeconds(firstAt: string, lastAt: string): number {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 1000);
}

/** The tools an HTTP exchange actually proves. Fetch always (it made requests);
 *  a form submitter only if a form signal was observed. We never list a tool we
 *  did not see exercised. */
function observedTools(signals: readonly AgentSignal[]): string[] {
  const tools = ["fetch"];
  if (signals.includes("form_honeypot") || signals.includes("form_too_fast")) tools.push("submit_form");
  return tools;
}

/** Derive a scaffolding read from the journey. Honest about live-traffic limits:
 *  a probed sensitive path is provably guessed (it is linked nowhere); a decoy
 *  trip is a followed (disallowed) link; otherwise we do not claim to know. */
function deriveScaffolding(journey: AgentJourney): AgentProfileScaffolding {
  const readsRobotsFirst = journey.path[0] === "/robots.txt";
  const probedSensitive = journey.signals.includes("probed_sensitive");
  const trippedDecoy = journey.signals.includes("tripped_decoy");
  let pathDiscovery: ScaffoldingSignature["pathDiscovery"];
  if (journey.path.length <= 1) pathDiscovery = "none";
  else if (probedSensitive && trippedDecoy) pathDiscovery = "mixed";
  else if (probedSensitive) pathDiscovery = "path-guessing";
  else if (trippedDecoy) pathDiscovery = "link-following";
  else pathDiscovery = "none";
  return {
    readsRobotsFirst,
    probedSensitive,
    pathDiscovery,
    requestCount: journey.eventCount,
    spanSeconds: spanSeconds(journey.firstAt, journey.lastAt),
    observability:
      "Derived from observed HTTP behavior. Live traffic proves a guessed path (linked nowhere) and a decoy trip (a disallowed link), but not an agent's internal tool menu; run the harness to exercise a full toolset.",
  };
}

function whyVerdict(journey: AgentJourney): string {
  if (journey.confidence === "proven") {
    if (journey.signals.includes("tripped_decoy")) return "Proven: it followed an invisible, robots-disallowed decoy link that a human cannot see.";
    if (journey.signals.includes("form_honeypot")) return "Proven: it filled a hidden honeypot form field that only a bot fills.";
    return "Proven: the session carried a correlation nonce the actor itself returned, so these events are one actor with certainty.";
  }
  return "Inferred: grouped by a coarse, non-PII fingerprint (user-agent + network + time window). A careful actor can pace itself to look human, so this is a likely match, not proof. It becomes proven if it trips the decoy or a hidden form field.";
}

/**
 * Build the profile for one journey. Pure and deterministic.
 */
export function buildAgentProfile(journey: AgentJourney): AgentProfile {
  const scaffoldingLite = deriveScaffolding(journey);
  const toolComposition = analyzeToolComposition(observedTools(journey.signals));

  // Reuse operatorKeyFor with a ScaffoldingSignature shaped from the observed
  // read, so a live-traffic bucket and a probe dossier share the same fingerprint
  // space (same operator surfaces the same key where the reads line up).
  const scaffoldingSig: ScaffoldingSignature = {
    stepCount: journey.eventCount,
    readsRobotsFirst: scaffoldingLite.readsRobotsFirst,
    followedLinks: journey.signals.includes("tripped_decoy") ? 1 : 0,
    guessedPaths: scaffoldingLite.probedSensitive ? 1 : 0,
    pathDiscovery: scaffoldingLite.pathDiscovery,
    retries: false,
    probedSensitive: scaffoldingLite.probedSensitive,
  };
  const operatorKey = operatorKeyFor(scaffoldingSig, toolComposition);

  const processes: ObservedProcess[] = journey.signals.map((s) => ({ signal: s, ...PROCESS_GLOSSARY[s] }));

  return {
    operatorKey,
    correlationKey: journey.key,
    verdict: { confidence: journey.confidence, why: whyVerdict(journey) },
    processes,
    scaffolding: scaffoldingLite,
    toolComposition,
    policies: toolComposition.policies,
    timeline: { firstAt: journey.firstAt, lastAt: journey.lastAt, spanSeconds: scaffoldingLite.spanSeconds, eventCount: journey.eventCount },
    disclaimer: DISCLAIMER,
    insights: journey.insights,
  };
}
