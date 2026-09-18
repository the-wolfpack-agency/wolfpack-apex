/**
 * Agent conduct rules - deterministic predicates that enforce the machine-
 * checkable part of agent conduct BEFORE an action runs, at the tool chokepoint.
 * Unlike the OGIAM Constitution prose (which only asks a model to behave), these
 * bind: they are a function of the action, not of the model's cooperation.
 *
 * SCOPE, DELIBERATELY HONEST.
 *   - Most conduct is ALREADY enforced upstream: stay in scope (capability +
 *     connector gates), no secrets (OGIAM deny), no destructive action without
 *     approval (the write-approval hold), no runaway loops (the per-hour
 *     ceiling). This file does not re-litigate those.
 *   - TRUTHFULNESS (do not fabricate, do not overclaim) CANNOT be a pre-execution
 *     gate: it is a property of an OUTPUT, not a checkable fact about an ACTION.
 *     Its control is the post-hoc behavior evals + human review, never a rule
 *     pretending to verify honesty here.
 *   - What THIS adds is the one clause that is both checkable and not already
 *     covered: an agent must not disarm the controls that govern it.
 */

/**
 * Capabilities that CONFIGURE the governance plane itself - entitlements,
 * Forcefield canaries, OGIAM enforcement posture, tenant provisioning, agent
 * management, and role/override changes. All are guarded behind these admin
 * capabilities today.
 */
export const GOVERNANCE_CONTROL_CAPABILITIES: ReadonlySet<string> = new Set([
  "settings.manage_team",
  "admin.roles.assign",
]);

export type ConductOutcome = "allow" | "deny";
export interface ConductVerdict {
  outcome: ConductOutcome;
  ruleId?: string;
  reason?: string;
}

/**
 * A GOVERNED AGENT may not invoke a control that governs agents - even if it
 * somehow holds the capability. An agent that can turn off its own security is
 * not governed, and an agent granting itself scope is privilege escalation. So
 * this denies, fail-closed, as defense in depth ON TOP OF the capability gate.
 * The human assistant is unaffected (isAgent === false).
 */
export function evaluateConduct(input: { capability: string; isAgent: boolean }): ConductVerdict {
  if (input.isAgent && GOVERNANCE_CONTROL_CAPABILITIES.has(input.capability)) {
    return {
      outcome: "deny",
      ruleId: "C-NO-SELF-TAMPER",
      reason: "an agent may not invoke a control that governs agents (self-tampering / privilege escalation)",
    };
  }
  return { outcome: "allow" };
}
