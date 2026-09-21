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
 * block decision (props always record posture "monitor", blocked false).
 */
import { classifyWebRequest } from "./classify";
import { classifyClient, headerSignature } from "./fingerprint";
import type { ForcefieldRuleset } from "./ruleset";

export type ForcefieldEventType =
  | "site.agent_welcomed"
  | "site.agent_flagged"
  | "site.agent_trap_tripped"
  | "site.agent_probed_sensitive";

export interface Observation {
  type: ForcefieldEventType;
  path: string;
  props: Record<string, string | number | boolean>;
}

export interface ObserveInput {
  /** The property this request hit (e.g. "instinct", "ogiam.com"). */
  surface: string;
  path: string;
  method: string;
  userAgent: string;
  country: string;
  /** Lowercased list of the request's header names (for the header-order sig). */
  headerNames: readonly string[];
  nowMs: number;
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

/** Does the path hit a sensitive/nonexistent recon path? Exact or one segment
 *  deeper (so "/wp-admin" and "/wp-admin/x" match, but "/.environment" does not
 *  match "/.env"). Returns the matched pattern, or null. */
function matchedSensitive(path: string, sensitivePaths: readonly string[]): string | null {
  for (const p of sensitivePaths) {
    if (path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)) return p;
  }
  return null;
}

/**
 * Inspect one request against the current ruleset. Most-severe first: a decoy
 * trip, then a sensitive-path probe, then a welcomed known agent, then flagged
 * automation (self-declared bot, a named scanner/library/headless tool, or a
 * browser UA whose headers don't match). A normal visitor returns null - the
 * common path, so nothing is forwarded for real users.
 */
export function observeRequest(input: ObserveInput, ruleset: ForcefieldRuleset): Observation | null {
  const { path, method, userAgent } = input;
  const verdict = classifyWebRequest(
    { path, method, userAgent },
    { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents },
  );
  const client = classifyClient(userAgent, input.headerNames, ruleset.toolSignatures);
  const probe = matchedSensitive(path, ruleset.sensitivePaths);

  let type: ForcefieldEventType | null = null;
  if (verdict.class === "trapped") type = "site.agent_trap_tripped";
  else if (probe) type = "site.agent_probed_sensitive";
  else if (verdict.class === "known_agent") type = "site.agent_welcomed";
  else if (
    verdict.class === "suspicious" ||
    client.clientType === "scanner" ||
    client.clientType === "scripted_library" ||
    client.clientType === "headless" ||
    client.headerMismatch
  ) {
    type = "site.agent_flagged";
  }
  if (!type) return null;

  const props: Record<string, string | number | boolean> = {
    sig: sessionSig(userAgent, input.country, input.headerNames, input.nowMs),
    surface: input.surface,
    posture: "monitor",
    action: "report",
    blocked: false,
    agent: verdict.matchedAgentId ?? "unidentified",
    client_type: client.clientType,
  };
  if (client.tool) props.tool = client.tool;
  if (probe) props.probe = probe;
  return { type, path, props };
}
