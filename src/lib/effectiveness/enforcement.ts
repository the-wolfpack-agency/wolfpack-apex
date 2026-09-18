/**
 * Downstream enforcement reader - the four agent-enforcement controls whose
 * denials happen AFTER the OGIAM authorize decision (so they are not in the
 * ogiam_decisions "governance" stream): the capability gate, connector-scope,
 * the operations-per-hour ceiling, and the conduct self-tamper gate.
 *
 * Each emits a workspace-scoped analytics event on denial (event_type + a
 * `workspace_id` in metadata). This reader counts them per workspace so the
 * effectiveness rollup can show enforcement that actually stopped an agent,
 * closing the four capture gaps the coverage ratchet tracked.
 *
 * TRUTHFUL BY CONSTRUCTION: counts only, straight from the event log. Counts are
 * cumulative and going-forward - events written before their emit site carried a
 * `workspace_id` are simply not attributable to a workspace and are not counted,
 * which undercounts rather than overclaims. A read error fails open to zeros
 * (the rollup degrades, it does not wedge).
 */
import { safeQuery } from "@/lib/db";

/** The enforcement-denial event each control emits. Kept here as the single
 *  source of truth so the emit sites, the reader, and the tests agree. */
export const ENFORCEMENT_EVENTS = {
  capabilityDenied: "agent.capability_denied",
  connectorScopeDenied: "agent.connector_scope_denied",
  ceilingHits: "agent.operation_ceiling_hit",
  conductDenied: "agent.conduct_denied",
} as const;

export interface EnforcementDenials {
  /** An agent action refused by the named-tool / role capability gate. */
  capabilityDenied: number;
  /** An agent reach for a connector it is not bound to. */
  connectorScopeDenied: number;
  /** An agent stopped by its operations-per-hour ceiling (runaway/loop). */
  ceilingHits: number;
  /** An agent that tried to invoke a control governing agents (self-tamper). */
  conductDenied: number;
  total: number;
}

export function emptyEnforcementDenials(): EnforcementDenials {
  return { capabilityDenied: 0, connectorScopeDenied: 0, ceilingHits: 0, conductDenied: 0, total: 0 };
}

export async function listEnforcementDenials(workspaceId: string): Promise<EnforcementDenials> {
  const byType: Record<string, string> = {
    [ENFORCEMENT_EVENTS.capabilityDenied]: "capabilityDenied",
    [ENFORCEMENT_EVENTS.connectorScopeDenied]: "connectorScopeDenied",
    [ENFORCEMENT_EVENTS.ceilingHits]: "ceilingHits",
    [ENFORCEMENT_EVENTS.conductDenied]: "conductDenied",
  };

  const { rows } = await safeQuery<{ event_type: string; n: string | number }>(
    `SELECT event_type, COUNT(*) AS n
       FROM instinct_events
      WHERE event_type = ANY($1)
        AND metadata->>'workspace_id' = $2
      GROUP BY event_type`,
    [Object.values(ENFORCEMENT_EVENTS), workspaceId],
  );

  const out = emptyEnforcementDenials();
  for (const r of rows) {
    const key = byType[r.event_type];
    if (!key) continue;
    const n = typeof r.n === "string" ? Number(r.n) : r.n;
    if (Number.isFinite(n) && n > 0) {
      (out as unknown as Record<string, number>)[key] = n;
    }
  }
  out.total = out.capabilityDenied + out.connectorScopeDenied + out.ceilingHits + out.conductDenied;
  return out;
}
