/**
 * Forcefield deception grid - the tripwire core.
 *
 * The rest of the runtime protection (the deny-by-default gate, the egress
 * allowlist, the MCP scanner, the hash-chained ledger, revocable agent creds)
 * already exists in OGIAM + containment. The one genuinely-missing piece is
 * DECEPTION: decoys that nothing legitimate ever touches, so any interaction is
 * a high-confidence signal you can respond to AUTOMATICALLY.
 *
 * This module is pure and deterministic on purpose:
 *   - `inspectAgentAction` decides TRIP or PASS against a canary registry.
 *   - `containmentFor` turns a trip into a fail-closed response DECISION
 *     (quarantine the agent + revoke its scope + open an incident).
 * The side effects live at the call site, which reuses what exists: record the
 * trip through the OGIAM ledger (recordDecision), revoke the agent's scoped
 * credential (agents/connections), and surface it in the OGIAM dashboard. Kept
 * pure so it is testable with no database and no model, like the code gate.
 *
 * A canary trip is treated as CRITICAL and fails closed: contain first, triage
 * after. Because a decoy is something no real user or well-behaved agent ever
 * reaches, that aggressive response carries near-zero false-positive risk.
 */

/** The OGIAM ledger rule id a canary trip is recorded under. Shared so the
 *  writer (the live containment adapter) and any reader (the triage view) match
 *  on the same string instead of two drifting literals. */
export const CANARY_TRIP_RULE_ID = "forcefield.canary_trip";

export type CanaryKind = "token" | "route" | "row" | "tool";

export interface Canary {
  id: string;
  kind: CanaryKind;
  /** The decoy value: the token string, the decoy route path, the honey-row id,
   *  or the honeypot tool name. */
  value: string;
  /** Where it was seeded - the dataset / surface. Carried into the trip so
   *  triage knows exactly WHERE the agent read it from. */
  seededIn: string;
}

/** A single runtime action by an agent, normalized for inspection. */
export interface AgentAction {
  workspaceId: string;
  agentId: string;
  kind: "tool_call" | "egress" | "data_read";
  /** tool_call: the tool name invoked. */
  tool?: string;
  /** egress: the destination URL. */
  url?: string;
  /** egress body or tool arguments, serialized - searched for exfiltrated token
   *  canaries. */
  payload?: string;
  /** data_read: the row ids the action touched. */
  rowIds?: string[];
}

export interface CanaryHit {
  canaryId: string;
  kind: CanaryKind;
  /** Where the tripped decoy was seeded - the source of the leak. */
  seededIn: string;
  reason: string;
}

export interface TripwireVerdict {
  tripped: boolean;
  hits: CanaryHit[];
  severity: "none" | "critical";
}

/** Pathname of a URL, for exact decoy-route matching. Non-URL strings compare
 *  whole, so a bare path (`/admin/export`) still matches. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Decide whether an agent action tripped a decoy. Deterministic: same action +
 * registry -> same verdict. Reports EVERY canary touched (an action can hit more
 * than one), each naming where it was seeded so triage is immediate.
 */
export function inspectAgentAction(action: AgentAction, canaries: readonly Canary[]): TripwireVerdict {
  const hits: CanaryHit[] = [];
  const path = action.url ? pathnameOf(action.url) : "";

  for (const c of canaries) {
    let reason: string | null = null;
    switch (c.kind) {
      case "token":
        // A seeded decoy credential / URL / record marker leaving in a payload.
        if (action.payload && c.value && action.payload.includes(c.value)) {
          reason = `canary token exfiltrated in an ${action.kind}`;
        }
        break;
      case "route":
        // A decoy endpoint no legitimate flow ever calls.
        if (path && path === c.value) reason = "decoy endpoint accessed";
        break;
      case "row":
        // A honey-row seeded into the client's data.
        if (action.rowIds && action.rowIds.includes(c.value)) reason = "honey-row read";
        break;
      case "tool":
        // A honeypot tool in the MCP manifest a hijacked agent reaches for.
        if (action.tool && action.tool === c.value) reason = "honeypot tool invoked";
        break;
    }
    if (reason) hits.push({ canaryId: c.id, kind: c.kind, seededIn: c.seededIn, reason });
  }

  return { tripped: hits.length > 0, hits, severity: hits.length > 0 ? "critical" : "none" };
}

export type ContainmentAction = "allow" | "quarantine";

export interface ContainmentDecision {
  action: ContainmentAction;
  /** Revoke the agent's scoped credential so it cannot act again. */
  revokeAgentScope: boolean;
  /** Open a hash-chained incident for triage. */
  openIncident: boolean;
  reason: string;
  hits: CanaryHit[];
}

/**
 * Turn a tripwire verdict into a fail-closed containment decision. A trip is
 * high-confidence malicious (nothing legitimate touches a decoy), so it ALWAYS
 * quarantines the agent, revokes its scope, and opens an incident - contain
 * first, triage after. No trip -> allow.
 */
export function containmentFor(verdict: TripwireVerdict, action: AgentAction): ContainmentDecision {
  if (!verdict.tripped) {
    return { action: "allow", revokeAgentScope: false, openIncident: false, reason: "no decoy touched", hits: [] };
  }
  const where = verdict.hits.map((h) => h.seededIn).join(", ");
  return {
    action: "quarantine",
    revokeAgentScope: true,
    openIncident: true,
    reason: `${verdict.hits.length} canary trip(s) [${where}]; agent ${action.agentId} quarantined and its scope revoked`,
    hits: verdict.hits,
  };
}
