/**
 * Forcefield triage - read the canary TRIPS an operator needs to see.
 *
 * When a decoy is touched, the live containment adapter records a DENY decision
 * in the OGIAM ledger under rule id CANARY_TRIP_RULE_ID (and revokes the agent).
 * This is the READ side: it asks the ledger for exactly those decisions so the
 * console can show what tripped, when, which agent was contained, and why.
 *
 * DRY: it reuses the ledger's own `listDecisions` (with the new ruleId filter)
 * rather than a second query path, and the SAME shared rule-id constant the
 * writer uses, so the two can never drift. No decoy value is in the ledger to
 * begin with (only hit metadata is recorded), so nothing here can leak one.
 */
import { listDecisions } from "@/lib/ogiam/queries";
import { CANARY_TRIP_RULE_ID } from "./tripwire";

export interface CanaryTrip {
  id: string;
  /** The agent that touched a decoy and was contained. */
  agent: string;
  whenIso: string;
  riskTier: string;
  /** Why it fired - names how many decoys and where they were seeded. */
  reason: string;
  /** True when containment actually took effect (enforced deny). */
  contained: boolean;
}

/** The most recent canary trips for a workspace, newest first. */
export async function listCanaryTrips(workspaceId: string, limit = 50): Promise<CanaryTrip[]> {
  const rows = await listDecisions(workspaceId, { ruleId: CANARY_TRIP_RULE_ID, limit });
  return rows.map((r) => ({
    id: r.id,
    agent: r.principal_agent,
    whenIso: r.created_at,
    riskTier: r.risk_tier,
    reason: r.reason ?? "canary trip",
    contained: r.effective_outcome === "deny" && r.enforced,
  }));
}
