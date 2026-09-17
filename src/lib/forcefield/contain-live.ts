/**
 * Forcefield containment - the LIVE adapter.
 *
 * `guardAgentAction` (./contain) is pure and takes its three side effects as
 * injected deps so it stays testable with no DB. This module is the thin glue
 * that wires those deps to the real infra, reusing what already exists rather
 * than rebuilding any of it:
 *
 *   loadCanaries      -> canary-store `listCanariesForMatching` (active decoys,
 *                        with values, for this workspace)
 *   revokeAgentScope  -> agents/store `setAgentState(id, ws, "revoked", actor)`
 *                        (the same revoke path a human admin uses; audited)
 *   recordTrip        -> ogiam/ledger `recordDecision` with a DENY decision, via
 *                        `buildAction` so the redactor + hashing stay DRY.
 *
 * SECRET SAFETY: the ledger record is built from the tripwire HIT METADATA only
 * (canary ids, kinds, and where each was seeded) - never the action payload and
 * never the decoy value itself. Recording the exfiltrated canary token into the
 * audit trail would defeat the point. The hits already carry no value.
 */

import { recordDecision } from "@/lib/ogiam/ledger";
import { buildAction } from "@/lib/ogiam/action";
import { POLICY_VERSION } from "@/lib/ogiam/policy";
import type { OgiamDecision, OgiamPrincipal } from "@/lib/ogiam/types";
import { setAgentState } from "@/lib/agents/store";
import { listCanariesForMatching } from "./canary-store";
import { CANARY_TRIP_RULE_ID } from "./tripwire";
import type { ContainmentDeps, TripRecord } from "./contain";

/** The system actor that owns an automatic containment. Not a human: a decoy
 *  trip is machine-decided, and the audit trail must say so honestly. */
const FORCEFIELD_ACTOR = { userId: "forcefield", role: "system" } as const;

/** Map a Forcefield trip onto the OGIAM ledger as a DENY decision and append it.
 *  Best effort by contract (recordDecision never throws, returns null on
 *  failure); the containment layer treats a null as a degraded audit, never a
 *  reason to skip the revoke. */
async function recordTripToLedger(trip: TripRecord): Promise<void> {
  const principal: OgiamPrincipal = {
    kind: "ai_agent",
    agent: trip.agentId,
    onBehalfOfUserId: trip.agentId,
    onBehalfOfRole: "agent",
    workspaceId: trip.workspaceId,
  };

  // HIT METADATA ONLY - no payload, no decoy value ever enters the ledger.
  const { action, redactedParams } = buildAction({
    tool: "forcefield.contain",
    capability: "forcefield.contain",
    isMutation: true,
    surface: "forcefield",
    params: {
      actionKind: trip.action.kind,
      hits: trip.decision.hits.map((h) => ({
        canaryId: h.canaryId,
        kind: h.kind,
        seededIn: h.seededIn,
      })),
    },
  });

  const decision: OgiamDecision = {
    intendedOutcome: "deny",
    effectiveOutcome: "deny",
    enforced: true,
    mode: "enforce",
    riskTier: "critical",
    policyVersion: POLICY_VERSION,
    ruleId: CANARY_TRIP_RULE_ID,
    reason: trip.decision.reason,
    wouldBlock: true,
  };

  await recordDecision({ principal, action, decision, redactedParams });
}

/**
 * Production containment deps wired to the real registry, agent store, and
 * OGIAM ledger. Pass to `guardAgentAction`. Both side effects stay best effort
 * inside the pure core - this adapter only supplies the concrete calls.
 */
export function liveContainmentDeps(): ContainmentDeps {
  return {
    loadCanaries: (workspaceId) => listCanariesForMatching(workspaceId),
    revokeAgentScope: async (workspaceId, agentId) => {
      await setAgentState(agentId, workspaceId, "revoked", FORCEFIELD_ACTOR);
    },
    recordTrip: (trip) => recordTripToLedger(trip),
  };
}
