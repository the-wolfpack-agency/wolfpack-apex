/**
 * Forcefield containment orchestration - turns a decoy touch into an ACTUAL
 * end-to-end response: load the workspace's canaries, inspect the action, and on
 * a trip both revoke the agent's scope (contain) and record the trip through the
 * OGIAM ledger (audit).
 *
 * The decision logic already exists and is pure (`inspectAgentAction` +
 * `containmentFor` in ./tripwire). This module is the ORCHESTRATION only, and it
 * takes its three side effects as injected dependencies so it:
 *   - reuses what already exists (canary registry read, OGIAM ledger
 *     `recordDecision`, agent scoped-credential revocation) instead of
 *     rebuilding any of it, and
 *   - stays testable with no database, no model, and no live agent - the flow is
 *     proven with in-memory fakes, exactly like the gate and the tripwire core.
 *
 * Fail-closed and independent: on a trip the revoke and the record are fired as
 * separate best-effort effects (Promise.allSettled). Containment must NOT depend
 * on the audit write succeeding - if the ledger is down we still revoke, and if
 * revoke throws we still leave an audit trail. A trip is high-confidence
 * malicious (nothing legitimate touches a decoy), so we never re-raise a
 * side-effect failure into the caller and accidentally let the agent proceed.
 */

import {
  inspectAgentAction,
  containmentFor,
  type AgentAction,
  type Canary,
  type ContainmentDecision,
} from "./tripwire";

/** What a trip carries into the audit record. Shaped so the live adapter can map
 *  it straight onto an OGIAM ledger decision without this module importing the
 *  ledger's principal/action types. */
export interface TripRecord {
  workspaceId: string;
  agentId: string;
  action: AgentAction;
  decision: ContainmentDecision;
}

/**
 * Injected side effects. In production these are wired to the real infra by
 * `liveContainmentDeps` (a thin adapter): `loadCanaries` -> the canary registry's
 * internal full-value read, `recordTrip` -> OGIAM `recordDecision`, and
 * `revokeAgentScope` -> the agent connection's scoped-credential revocation.
 */
export interface ContainmentDeps {
  /** All active canaries for the workspace, WITH decoy values, for matching. */
  loadCanaries: (workspaceId: string) => Promise<readonly Canary[]>;
  /** Revoke the agent's scoped credential so it cannot act again. */
  revokeAgentScope: (workspaceId: string, agentId: string) => Promise<void>;
  /** Write the trip to the hash-chained OGIAM ledger for triage. */
  recordTrip: (trip: TripRecord) => Promise<void>;
}

export interface ContainmentOutcome {
  decision: ContainmentDecision;
  /** True once containment side effects were dispatched (a trip). */
  contained: boolean;
  /** Which side effects succeeded - surfaced so triage/tests can see a degraded
   *  audit or revoke without the failure ever blocking containment. */
  revoked: boolean;
  recorded: boolean;
}

async function settled(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect one agent action against the workspace's live canaries and, on a trip,
 * contain the agent end to end. Returns the containment decision plus which
 * effects landed. Never throws on a side-effect failure - a decoy touch is
 * treated as malicious regardless of whether the ledger or the revoke succeeded.
 */
export async function guardAgentAction(
  action: AgentAction,
  deps: ContainmentDeps,
): Promise<ContainmentOutcome> {
  const canaries = await deps.loadCanaries(action.workspaceId);
  const verdict = inspectAgentAction(action, canaries);
  const decision = containmentFor(verdict, action);

  if (decision.action !== "quarantine") {
    return { decision, contained: false, revoked: false, recorded: false };
  }

  // Contain and audit as INDEPENDENT best-effort effects. Neither blocks the
  // other; a failure in one must not stop the other or reach the caller.
  const [revoked, recorded] = await Promise.all([
    settled(deps.revokeAgentScope(action.workspaceId, action.agentId)),
    settled(deps.recordTrip({ workspaceId: action.workspaceId, agentId: action.agentId, action, decision })),
  ]);

  return { decision, contained: true, revoked, recorded };
}
