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

/** One observed event for an operator, in the shape the board already has. */
export interface AgentIntelEvent {
  /** ISO timestamp. */
  at: string;
  /** The property the request hit (e.g. "instinct", "ogiam.com"). */
  site: string;
  /** Was the request turned away by enforcement. */
  blocked: boolean;
  /** UA-derived client family: headless_chrome, scripted_library, browser, known_crawler, unknown. */
  clientType?: string;
  /** UA-derived tool: HeadlessChrome, curl, python-requests, sqlmap, ... */
  tool?: string;
  /** Structural signals on this event (read_robots, probed_sensitive, tripped_decoy, payload_attack, ...). */
  signals?: string[];
  /** Hosting label from the edge: "datacenter" | "residential" | "unknown". */
  hosting?: string;
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
const HOSTILE_SIGNALS = new Set(["payload_attack", "tripped_decoy", "id_enumeration", "probed_sensitive"]);
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
export type ClientClass = "ai_agent" | "automation_framework" | "script" | "browser" | "unknown";
export interface ClientClassResult {
  clientClass: ClientClass;
  why: string;
}
const SCRIPT_TOOLS = /curl|wget|python-requests|urllib|httpx|go-http|libwww|okhttp|axios|node-fetch|scrapy/i;
const FRAMEWORK_TOOLS = /headless|puppeteer|playwright|selenium|phantom|chromedriver/i;
const AI_TOOLS = /gptbot|claude|perplexity|anthropic|openai|chatgpt|bytespider|ccbot|google-extended|cohere/i;
export function clientClass(events: readonly AgentIntelEvent[]): ClientClassResult {
  const tools = events.map((e) => e.tool ?? "").join(" ");
  const types = new Set(events.map((e) => e.clientType ?? ""));
  const signals = new Set(events.flatMap((e) => e.signals ?? []));
  // A named AI crawler/agent, or the exploration pattern of one: reads the rules
  // (robots/sitemap) THEN reasons its way to sensitive paths, rather than brute-
  // forcing. That read-then-target sequence is the AI-agent tell.
  if (AI_TOOLS.test(tools)) return { clientClass: "ai_agent", why: "Identified AI-agent user-agent." };
  if ((signals.has("read_robots") || signals.has("read_sitemap")) && (signals.has("probed_sensitive") || signals.has("id_enumeration"))) {
    return { clientClass: "ai_agent", why: "Read the rules, then reasoned toward sensitive paths - autonomous exploration, not brute force." };
  }
  if (FRAMEWORK_TOOLS.test(tools) || types.has("headless_chrome")) {
    return { clientClass: "automation_framework", why: "Headless browser / automation framework (Headless Chrome, Puppeteer, Playwright, Selenium)." };
  }
  if (SCRIPT_TOOLS.test(tools) || types.has("scripted_library")) {
    return { clientClass: "script", why: "A scripted HTTP client (curl / python-requests / urllib / library)." };
  }
  if (types.has("browser") || types.has("known_crawler")) {
    return { clientClass: "browser", why: "A real browser or an identified, rule-respecting crawler." };
  }
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
