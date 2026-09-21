/**
 * Instinct self-defense: classify Instinct's OWN inbound web traffic with the
 * pure Forcefield core and turn a non-normal verdict into a site-event to forward
 * to the analytics ingest, tagged `surface: "instinct"` so it lands on the one
 * shared board alongside ogiam.com (and, later, the other properties).
 *
 * PURE + EDGE-SAFE by construction: no I/O, no Node APIs, no DB - it only reads a
 * few request fields and returns a plain object (or null). It is monitor-only by
 * design: it produces an OBSERVATION, never a block decision. The caller (edge
 * middleware) fires the forward fire-and-forget and is wrapped so this can never
 * affect a real request. Activated only when FORCEFIELD_WEB is on.
 */
import { classifyWebRequest, type SiteForcefieldConfig } from "./classify";

/** The forwarded event vocabulary (a subset of SiteEventType). Declared locally
 *  as string literals so this edge module never imports the DB-backed analytics
 *  module - keeping the whole path free of anything that can't run on the edge. */
export type InstinctForcefieldEvent =
  | "site.agent_welcomed"
  | "site.agent_flagged"
  | "site.agent_trap_tripped";

/** Instinct's welcome lane: major, well-behaved crawlers. Everything else that
 *  self-declares as automation is flagged (recorded, never blocked). */
const INSTINCT_KNOWN_AGENTS = [
  { id: "Googlebot", uaMatch: "Googlebot" },
  { id: "Bingbot", uaMatch: "bingbot" },
  { id: "GPTBot", uaMatch: "GPTBot" },
  { id: "OAI-SearchBot", uaMatch: "OAI-SearchBot" },
  { id: "ChatGPT-User", uaMatch: "ChatGPT-User" },
  { id: "ClaudeBot", uaMatch: "ClaudeBot" },
  { id: "PerplexityBot", uaMatch: "PerplexityBot" },
  { id: "Applebot", uaMatch: "Applebot" },
  { id: "DuckDuckBot", uaMatch: "DuckDuckBot" },
  { id: "Amazonbot", uaMatch: "Amazonbot" },
] as const;

/** An invisible honeypot path. Instinct is an authed app rather than a crawlable
 *  site, so this is a passive tripwire: any client that requests it is a scanner,
 *  never a real user or a good crawler (robots.txt disallows it). */
export const INSTINCT_TRAP_PATHS = ["/_ff/records"] as const;

export const INSTINCT_FORCEFIELD_CONFIG: SiteForcefieldConfig = {
  trapPaths: INSTINCT_TRAP_PATHS,
  knownAgents: INSTINCT_KNOWN_AGENTS,
};

/** A stable, non-PII correlation key: an FNV-1a hash of UA + country + a one-hour
 *  time bucket, so one actor's requests within an hour cluster into a session. No
 *  IP, no raw identifier - the same shape the site pipeline uses. Edge-safe. */
export function fingerprintWeb(userAgent: string, country: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / 3_600_000);
  const s = `${userAgent}|${country}|${bucket}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface InstinctObservation {
  type: InstinctForcefieldEvent;
  path: string;
  props: Record<string, string | number | boolean>;
}

/**
 * Inspect one Instinct request. Returns an observation to forward, or null for a
 * normal visitor (the overwhelming majority - so the common path is a cheap
 * classify and an early null, and nothing is forwarded). Monitor-only: props
 * always record `posture: "monitor"`, `blocked: false`.
 */
export function inspectInstinctRequest(input: {
  path: string;
  method: string;
  userAgent: string;
  country: string;
  nowMs: number;
}): InstinctObservation | null {
  const verdict = classifyWebRequest(
    { path: input.path, method: input.method, userAgent: input.userAgent },
    INSTINCT_FORCEFIELD_CONFIG,
  );
  if (verdict.class === "normal") return null;
  const type: InstinctForcefieldEvent =
    verdict.class === "trapped"
      ? "site.agent_trap_tripped"
      : verdict.class === "known_agent"
        ? "site.agent_welcomed"
        : "site.agent_flagged";
  return {
    type,
    path: input.path,
    props: {
      sig: fingerprintWeb(input.userAgent, input.country, input.nowMs),
      surface: "instinct",
      posture: "monitor",
      action: "report",
      blocked: false,
      agent: verdict.matchedAgentId ?? "unidentified",
    },
  };
}
