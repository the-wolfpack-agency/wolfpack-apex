/**
 * Agent intelligence - deeper per-operator profiling from the traffic we already
 * capture, to make a caught agent legible beyond "it used HeadlessChrome". Four
 * lenses, each a pure function over one operator's ordered events:
 *
 *   1. crossSiteFootprint - which of our properties the operator hit. One actor
 *      across several sites is a coordinated campaign, not an isolated visit -
 *      the "immune system across sites" story, made concrete.
 *   2. cadenceSignature - the rhythm between requests. Humans are irregular;
 *      automation is machine-regular or bursty. Catches the low-and-slow scraper
 *      that never trips a rate threshold.
 *   3. adaptiveReaction - what the operator did AFTER we turned it away. An agent
 *      that persists or escalates after a block is a more determined adversary
 *      than one that gives up.
 *   4. clientClass - is this an autonomous AI agent, an automation framework, a
 *      dumb script, or a browser? OGIAM protects against AI agents specifically,
 *      so naming that is the on-brand differentiator.
 *
 * Pure + deterministic + non-PII (operates on the same header-hash fingerprints
 * and coarse country the rest of Forcefield uses; never an IP or identity).
 */
import { DEFAULT_TOOL_SIGNATURES, type ClientType } from "@/lib/forcefield-web/fingerprint";
import type { AgentSignal } from "@/lib/agent-behavior";

/** One observed event for an operator, in the shape the board already has. */
export interface AgentIntelEvent {
  /** ISO timestamp. */
  at: string;
  /** The property the request hit (e.g. "instinct", "ogiam.com"). */
  site: string;
  /** Was the request turned away by enforcement. */
  blocked: boolean;
  /** UA-derived client family (props.client_type, a fingerprint ClientType):
   *  scanner, headless, scripted_library, known_crawler, browser, unknown. */
  clientType?: string;
  /** UA-derived tool: HeadlessChrome, curl, python-requests, sqlmap, ... */
  tool?: string;
  /** Structural signals on this event (read_robots, probed_sensitive, tripped_decoy, payload_attack, ...). */
  signals?: string[];
  /** Hosting label from the edge: "datacenter" | "residential" | "unknown". */
  hosting?: string;
  /** The allowlisted agent id the request claimed (props.agent), when any. */
  agent?: string;
  /** The agent id this request CLAIMED but failed to verify (props.impersonating). */
  impersonating?: string;
  /** props.agent_verification: "verified" | "impersonation" | "unverifiable". */
  agentVerification?: string;
  /** props.signed_agent: a valid signed-agent (Web Bot Auth) identity. */
  signedAgent?: boolean;
}

// ── 1. Cross-site footprint ──────────────────────────────────────────────────
export interface CrossSiteFootprint {
  sites: string[];
  siteCount: number;
  /** True when the same operator is active on more than one property. */
  campaign: boolean;
}
export function crossSiteFootprint(events: readonly AgentIntelEvent[]): CrossSiteFootprint {
  const sites = Array.from(new Set(events.map((e) => e.site).filter(Boolean))).sort();
  return { sites, siteCount: sites.length, campaign: sites.length > 1 };
}

// ── 2. Cadence / rhythm ──────────────────────────────────────────────────────
export type Rhythm = "single" | "machine_regular" | "bursty" | "human_like";
export interface CadenceSignature {
  requests: number;
  /** Median seconds between consecutive requests (0 for a single request). */
  medianGapSec: number;
  /** Coefficient of variation of the gaps: low = metronomic, high = irregular. */
  variability: number;
  rhythm: Rhythm;
  /** True when the rhythm reads as automated rather than human. */
  automated: boolean;
}
export function cadenceSignature(events: readonly AgentIntelEvent[]): CadenceSignature {
  const ts = events.map((e) => Date.parse(e.at)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (ts.length < 2) return { requests: ts.length, medianGapSec: 0, variability: 0, rhythm: "single", automated: false };
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const variability = mean > 0 ? Math.sqrt(variance) / mean : 0;
  // Metronomic (low variability) OR very fast median => automation. Irregular AND
  // human-paced (>= ~2s median) reads human-like. Bursts sit in between.
  let rhythm: Rhythm;
  if (variability < 0.4) rhythm = "machine_regular";
  else if (median < 1) rhythm = "bursty";
  else rhythm = "human_like";
  const automated = rhythm === "machine_regular" || rhythm === "bursty" || median < 1;
  return { requests: ts.length, medianGapSec: Math.round(median * 100) / 100, variability: Math.round(variability * 100) / 100, rhythm, automated };
}

// ── 3. Adaptive reaction ─────────────────────────────────────────────────────
export type Reaction = "none" | "gave_up" | "persisted" | "escalated";
// Typed against the AgentSignal vocabulary (agent-behavior) so a label here can
// never be one nothing emits.
const HOSTILE_SIGNALS: ReadonlySet<string> = new Set<AgentSignal>(["payload_attack", "tripped_decoy", "id_enumeration", "probed_sensitive", "form_honeypot"]);
export interface AdaptiveReaction {
  blockedCount: number;
  /** Events that occurred AFTER the operator's first block. */
  eventsAfterBlock: number;
  reaction: Reaction;
}
export function adaptiveReaction(events: readonly AgentIntelEvent[]): AdaptiveReaction {
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const blockedCount = ordered.filter((e) => e.blocked).length;
  const firstBlockIdx = ordered.findIndex((e) => e.blocked);
  if (firstBlockIdx === -1) return { blockedCount: 0, eventsAfterBlock: 0, reaction: "none" };
  const after = ordered.slice(firstBlockIdx + 1);
  if (after.length === 0) return { blockedCount, eventsAfterBlock: 0, reaction: "gave_up" };
  // Escalated if a hostile signal appears AFTER the block that was not present
  // before it; otherwise it simply persisted.
  const before = new Set(ordered.slice(0, firstBlockIdx + 1).flatMap((e) => e.signals ?? []));
  const escalated = after.some((e) => (e.signals ?? []).some((s) => HOSTILE_SIGNALS.has(s) && !before.has(s)));
  return { blockedCount, eventsAfterBlock: after.length, reaction: escalated ? "escalated" : "persisted" };
}

// ── 4. Client class (AI agent vs automation vs script vs browser) ────────────
// Every label below is keyed off what the engine ACTUALLY emits: the ClientType
// union and DEFAULT_TOOL_SIGNATURES from forcefield-web/fingerprint, and the
// agent ids from the ruleset. CLIENT_TYPE_CLASS is a Record over ClientType, so a
// new client type that is not mapped here fails the build instead of silently
// reading "unknown" (the "headless_chrome" vs "headless" drift that hid 8.5k
// headless events from the automation count).
export type ClientClass =
  | "impersonator" // claimed a known agent's identity and failed verification: hostile automation
  | "ai_agent"
  | "scanner"
  | "automation_framework"
  | "script"
  | "crawler"
  | "browser"
  | "unknown";
export interface ClientClassResult {
  clientClass: ClientClass;
  why: string;
}

/** ClientType (fingerprint.ts) -> client class. Exhaustive by type. */
export const CLIENT_TYPE_CLASS: Readonly<Record<ClientType, ClientClass>> = {
  scanner: "scanner",
  headless: "automation_framework",
  scripted_library: "script",
  known_crawler: "crawler",
  browser: "browser",
  unknown: "unknown",
};

/** Agent ids (as the ruleset names them, compared case-insensitively) that are
 *  AI crawlers, AI search indexers, or AI assistants acting for a user. An id on
 *  this list is an AI agent only while its identity holds up: an impersonating
 *  claim is classed as hostile automation instead. */
export const AI_AGENT_IDS: readonly string[] = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot",
  "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User",
  "MistralAI-User",
  "Meta-ExternalAgent", "Meta-ExternalFetcher",
  "Google-Extended", "Google-CloudVertexBot", "Applebot-Extended",
  "Bytespider", "CCBot", "cohere-ai", "DuckAssistBot", "YouBot",
];
const AI_AGENT_SET = new Set(AI_AGENT_IDS.map((a) => a.toLowerCase()));
export function isAiAgentId(id: string | undefined): boolean {
  return !!id && AI_AGENT_SET.has(id.toLowerCase());
}

/** Tool display name (as fingerprint emits it in props.tool) -> client type,
 *  derived from the bundled signatures so a tool name can never drift from the
 *  detector. The regexes below are only a fallback for tools a central ruleset
 *  added that the bundle does not know. */
const TOOL_TYPE = new Map<string, ClientType>(DEFAULT_TOOL_SIGNATURES.map(([display, , type]) => [display.toLowerCase(), type]));
const SCRIPT_TOOLS = /curl|wget|python-requests|urllib|httpx|aiohttp|go-http|libwww|okhttp|axios|node-fetch|scrapy|java\/|httpclient|guzzle|httpie/i;
const FRAMEWORK_TOOLS = /headless|puppeteer|playwright|selenium|phantom|chromedriver|electron/i;
const SCANNER_TOOLS = /sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|gobuster|feroxbuster|dirbuster|ffuf|acunetix|nessus|censys|shodan|zmap/i;
const AI_TOOLS = /gptbot|claude|perplexity|anthropic|openai|chatgpt|bytespider|ccbot|google-extended|cohere|mistral/i;

export function clientClass(events: readonly AgentIntelEvent[]): ClientClassResult {
  const tools = events.map((e) => e.tool ?? "").filter(Boolean);
  const toolText = tools.join(" ");
  const types = new Set<string>(events.map((e) => e.clientType ?? "").filter(Boolean));
  for (const t of tools) {
    const mapped = TOOL_TYPE.get(t.toLowerCase());
    if (mapped) types.add(mapped);
  }
  const signals = new Set(events.flatMap((e) => e.signals ?? []));
  const has = (ct: ClientType) => types.has(ct);

  // 1. A claimed identity that failed verification. Wearing a good agent's badge
  //    from the wrong network is hostile automation, never "an AI agent".
  const imp = events.find((e) => e.impersonating || e.agentVerification === "impersonation");
  if (imp) {
    const claimed = imp.impersonating || imp.agent || "a known agent";
    return { clientClass: "impersonator", why: `Claimed to be ${claimed}, but the request did not come from ${claimed}'s published network. Hostile automation wearing a good agent's identity.` };
  }
  // 2. A named AI agent (allowlisted id) or a cryptographically signed agent.
  const ai = events.find((e) => isAiAgentId(e.agent));
  if (ai) {
    const verified = events.some((e) => e.agentVerification === "verified" || e.signedAgent);
    return { clientClass: "ai_agent", why: verified ? `Identified AI agent (${ai.agent}), identity verified.` : `Identified AI agent (${ai.agent}) by its declared identity; not independently verified.` };
  }
  if (events.some((e) => e.signedAgent)) return { clientClass: "ai_agent", why: "Presented a valid signed-agent identity (Web Bot Auth)." };
  if (AI_TOOLS.test(toolText)) return { clientClass: "ai_agent", why: "Identified AI-agent user-agent." };
  // 3. A named attack tool outranks everything below it.
  if (has("scanner") || SCANNER_TOOLS.test(toolText)) {
    return { clientClass: "scanner", why: "A named recon / vulnerability scanner (sqlmap, Nuclei, Nikto, ...)." };
  }
  // 4. The exploration pattern of an AI agent: reads the rules (robots/sitemap)
  //    THEN reasons its way to sensitive paths, rather than brute-forcing.
  if ((signals.has("read_robots") || signals.has("read_sitemap")) && (signals.has("probed_sensitive") || signals.has("id_enumeration"))) {
    return { clientClass: "ai_agent", why: "Read the rules, then reasoned toward sensitive paths - autonomous exploration, not brute force." };
  }
  if (has("headless") || FRAMEWORK_TOOLS.test(toolText)) {
    return { clientClass: "automation_framework", why: "Headless browser / automation framework (Headless Chrome, Puppeteer, Playwright, Selenium)." };
  }
  if (has("scripted_library") || SCRIPT_TOOLS.test(toolText)) {
    return { clientClass: "script", why: "A scripted HTTP client (curl / python-requests / urllib / library)." };
  }
  if (has("known_crawler")) return { clientClass: "crawler", why: "An identified, rule-respecting crawler." };
  if (has("browser")) return { clientClass: "browser", why: "A real browser." };
  return { clientClass: "unknown", why: "Not enough signal to classify the client." };
}

// ── Combined profile ─────────────────────────────────────────────────────────
export interface AgentIntelligence {
  crossSite: CrossSiteFootprint;
  cadence: CadenceSignature;
  adaptive: AdaptiveReaction;
  client: ClientClassResult;
}
export function analyzeAgent(events: readonly AgentIntelEvent[]): AgentIntelligence {
  return {
    crossSite: crossSiteFootprint(events),
    cadence: cadenceSignature(events),
    adaptive: adaptiveReaction(events),
    client: clientClass(events),
  };
}
