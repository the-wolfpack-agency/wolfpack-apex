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

/** The canonical decoy kinds, in display order. Lives here (the pure tripwire
 *  core, no DB) so read-only consumers can import it without pulling in the
 *  store's database dependencies. */
export const CANARY_KINDS: readonly CanaryKind[] = ["token", "route", "row", "tool"];

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

/**
 * A single runtime action, normalized for inspection. Every surface a decoy can
 * be USED from maps onto this shape:
 *   - tool_call:       an agent invoking a tool (name + serialized args)
 *   - tool_output:     what a tool returned to an agent (a decoy in the output
 *                      means the agent reached data nothing legitimate reads)
 *   - egress:          an agent sending data out (destination + body)
 *   - data_read:       an agent reading rows (row ids)
 *   - inbound_request: a request arriving at a connected site or at the agent
 *                      API (path / raw URL / header values / body or message)
 */
export interface AgentAction {
  workspaceId: string;
  /** The agent, or for an inbound request with no agent, a stable label for the
   *  client (e.g. "site:<label>"). */
  agentId: string;
  kind: "tool_call" | "egress" | "data_read" | "tool_output" | "inbound_request";
  /** tool_call / tool_output: the tool name. */
  tool?: string;
  /** egress: the destination URL. inbound_request: the requested URL or path. */
  url?: string;
  /** egress body, tool arguments, or an inbound body / agent message,
   *  serialized - searched for every decoy value. */
  payload?: string;
  /** tool_output: the tool's result, serialized. */
  output?: string;
  /** inbound_request: header VALUES, serialized (a decoy credential presented
   *  as Authorization / x-api-key lands here). */
  headers?: string;
  /** data_read: the row ids the action touched. */
  rowIds?: string[];
}

export interface CanaryHit {
  canaryId: string;
  kind: CanaryKind;
  /** Where the tripped decoy was seeded - the source of the leak. */
  seededIn: string;
  reason: string;
  /** Which part of the action carried it (path, url, payload, output, headers,
   *  rowIds, tool). Never the value itself. */
  surface: string;
}

export interface TripwireVerdict {
  tripped: boolean;
  hits: CanaryHit[];
  severity: "none" | "critical";
}

/** Pathname of a URL, for exact decoy-route matching. Non-URL strings compare
 *  whole (minus any query), so a bare path (`/admin/export`) still matches. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const q = url.search(/[?#]/);
    return q >= 0 ? url.slice(0, q) : url;
  }
}

/** A decoy value shorter than this is matched only structurally (exact path,
 *  row id, tool name), never by substring, so a short value cannot collide with
 *  ordinary text. Seeded decoys are 30+ random characters. */
export const MIN_SCAN_LENGTH = 8;

const WORD = /[A-Za-z0-9_-]/;

/** True when `value` occurs in `hay` as a whole token: not glued to a longer
 *  identifier on either side (so `/admin/export-all-report` does not contain the
 *  decoy `/admin/export-all`). A value starting with `/` is its own left
 *  boundary. Also matches the URL-encoded form. */
export function containsDecoy(hay: string | undefined, value: string): boolean {
  if (!hay || !value || value.length < MIN_SCAN_LENGTH) return false;
  const forms = new Set([value, encodeURIComponent(value)]);
  for (const v of forms) {
    let from = 0;
    for (;;) {
      const i = hay.indexOf(v, from);
      if (i < 0) break;
      const before = i > 0 ? hay[i - 1] : "";
      const after = hay[i + v.length] ?? "";
      const leftOk = v.startsWith("/") || !before || !WORD.test(before);
      const rightOk = !after || !WORD.test(after);
      if (leftOk && rightOk) return true;
      from = i + 1;
    }
  }
  return false;
}

const KIND_REASON: Record<CanaryKind, string> = {
  token: "canary credential presented or exfiltrated",
  route: "decoy endpoint accessed",
  row: "honey-row reached",
  tool: "honeypot tool invoked",
};

/**
 * Decide whether an action tripped a decoy. Deterministic: same action +
 * registry -> same verdict. Reports EVERY canary touched (an action can hit more
 * than one), each naming where it was seeded and which part of the action
 * carried it, so triage is immediate.
 *
 * Every kind is detectable on every surface it can be used from: a decoy value
 * is a unique random string nothing legitimate contains, so its appearance as a
 * whole token anywhere in the action (path, URL, headers, payload, output) is a
 * trip, alongside the structural matches (exact decoy path, row id, tool name).
 */
export function inspectAgentAction(action: AgentAction, canaries: readonly Canary[]): TripwireVerdict {
  const hits: CanaryHit[] = [];
  const path = action.url ? pathnameOf(action.url) : "";
  const scanned: [string, string | undefined][] = [
    ["url", action.url],
    ["headers", action.headers],
    ["payload", action.payload],
    ["output", action.output],
  ];

  for (const c of canaries) {
    if (!c.value) continue;
    let surface: string | null = null;
    // Structural matches first (exact, any length).
    if (c.kind === "route" && path && path === c.value) surface = "path";
    else if (c.kind === "tool" && action.tool && action.tool === c.value) surface = "tool";
    else if (c.kind === "tool" && path && (path === c.value || path.endsWith(`/${c.value}`))) surface = "path";
    else if (c.kind === "row" && action.rowIds && action.rowIds.includes(c.value)) surface = "rowIds";
    else {
      for (const [name, hay] of scanned) {
        if (containsDecoy(hay, c.value)) {
          surface = name;
          break;
        }
      }
    }
    if (surface) {
      hits.push({ canaryId: c.id, kind: c.kind, seededIn: c.seededIn, surface, reason: `${KIND_REASON[c.kind]} (${surface}, ${action.kind})` });
    }
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
