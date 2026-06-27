/**
 * OGIAM policy decision point (PDP). Pure and deterministic.
 *
 * Core principle: models advise, only policy authorizes. Signals (PII, secret,
 * injection) are inputs; the DECISION is a deterministic function of the action,
 * the signals, and the policy version. The same inputs always yield the same
 * decision, and the rule that fired is always recorded, so every decision is
 * explainable and reproducible. That is what makes this an authorization gate
 * rather than another probabilistic guardrail.
 *
 * Phase 0 ships a deliberately conservative, small rule set. Rules are tried in
 * order; the FIRST match wins and names itself (ruleId + reason). Swapping this
 * for Cedar or OPA later is a PDP-internal change; callers see the same Decision.
 */

import type {
  OgiamAction,
  OgiamDecision,
  OgiamEnforcementMode,
  OgiamIntendedOutcome,
  OgiamRiskTier,
} from "./types";

/** Bump on any rule or tiering change so decisions stay reproducible against a
 *  known policy. Date plus a same-day revision counter. */
export const POLICY_VERSION = "ogiam-2026-06-24.1";

/** Injection score at or above which a mutation is escalated. Advisory PIP. */
export const INJECTION_ESCALATE_THRESHOLD = 0.8;

/**
 * Capabilities and tool-name fragments that mark an action as high risk: money
 * movement, outbound send, data export, destructive ops, and privilege grants.
 * Matched case-insensitively against the capability and the tool name. Kept as
 * an explicit, reviewable list (the blast radius of "what counts as high risk").
 */
const HIGH_RISK_FRAGMENTS = [
  "send",
  "export",
  "delete",
  "remove",
  "destroy",
  "purge",
  "finance",
  "invoice",
  "payment",
  "payout",
  "wire",
  "refund",
  "grant",
  "revoke",
  "provision",
  "impersonate",
  "admin",
];

/** Tools that send PII outbound and should redact rather than block. */
const OUTBOUND_SEND_FRAGMENTS = ["mail", "send", "message", "email", "post"];

function matchesAny(haystacks: string[], fragments: string[]): boolean {
  const lowered = haystacks.map((h) => (h || "").toLowerCase());
  return fragments.some((f) => lowered.some((h) => h.includes(f)));
}

/** Deterministic risk tier for an action. */
export function riskTierFor(action: OgiamAction): OgiamRiskTier {
  if (action.signals.secretDetected) return "critical";
  if (!action.isMutation) return "low";
  if (matchesAny([action.capability, action.tool], HIGH_RISK_FRAGMENTS)) {
    return "high";
  }
  return "medium";
}

interface RuleHit {
  ruleId: string;
  reason: string;
  intendedOutcome: OgiamIntendedOutcome;
}

/** Evaluate the ordered rule set. First match wins. Always returns a hit
 *  (the final default rule allows). */
function evaluateRules(action: OgiamAction, tier: OgiamRiskTier): RuleHit {
  // A credential in the parameters is never allowed to flow through an action.
  if (action.signals.secretDetected) {
    return {
      ruleId: "R-SECRET-DENY",
      reason: "a secret or credential was detected in the action parameters",
      intendedOutcome: "deny",
    };
  }

  // A strong injection signal on a state-changing action means a human decides.
  if (
    action.isMutation &&
    typeof action.signals.injectionScore === "number" &&
    action.signals.injectionScore >= INJECTION_ESCALATE_THRESHOLD
  ) {
    return {
      ruleId: "R-INJECTION-ESCALATE",
      reason: "a likely prompt injection is driving a state-changing action",
      intendedOutcome: "escalate",
    };
  }

  // Active penetration testing is explicitly allowed at the gate because by the
  // time it reaches here the pentest harness has already verified an admin-issued
  // scope token (the human authorization-to-test), the request budget, the kill
  // switch, the allowed host + technique, and the SSRF floor. The gate still
  // RECORDS every pentest decision to the ledger. A secret in params (above) still
  // denies and a strong injection signal (above) still escalates, so those wider
  // protections are unaffected. This explicit rule keeps the outcome intentional
  // even if the high-risk fragment list later changes.
  if (action.capability === "platform.pentest") {
    return {
      ruleId: "R-PENTEST-SCOPED-ALLOW",
      reason: "authorized active pentest, bounded by an issued scope token + the harness",
      intendedOutcome: "allow",
    };
  }

  // PII heading outbound is redacted (transformed), not blocked.
  if (
    action.signals.piiDetected &&
    matchesAny([action.capability, action.tool], OUTBOUND_SEND_FRAGMENTS)
  ) {
    return {
      ruleId: "R-PII-OUTBOUND-TRANSFORM",
      reason: "PII is present in an outbound action and must be redacted first",
      intendedOutcome: "transform",
    };
  }

  // High-risk mutations require explicit human approval.
  if (tier === "high") {
    return {
      ruleId: "R-HIGHRISK-MUTATION-ESCALATE",
      reason: "a high-risk state-changing action requires human approval",
      intendedOutcome: "escalate",
    };
  }

  // Any other (medium-risk) mutation is allowed: the principal only reached this
  // tool because the role gate authorized it, and OGIAM reserves escalation for
  // HIGH-risk actions (money, send, delete, admin) and denial for secrets. This
  // is what lets an agent do its authorized job, exactly as the human whose role
  // it carries would, while still stopping the dangerous actions. The human
  // assistant additionally hits the dispatcher's confirm-before-mutate gate, so
  // a person still confirms; an agent acting on assigned work does not need a
  // second per-action approval inside its authorized envelope.
  if (action.isMutation) {
    return {
      ruleId: "R-MUTATION-ALLOW",
      reason: "a state-changing action within the principal's authorized role",
      intendedOutcome: "allow",
    };
  }

  // Read-only, low risk: allowed.
  return {
    ruleId: "R-DEFAULT-ALLOW",
    reason: "a read-only action within policy",
    intendedOutcome: "allow",
  };
}

/**
 * Decide on an action. Pure: no IO, no clock, no randomness, so it is trivially
 * unit testable and reproducible.
 */
export function decide(
  action: OgiamAction,
  opts: { mode: OgiamEnforcementMode },
): OgiamDecision {
  const tier = riskTierFor(action);
  const hit = evaluateRules(action, tier);
  const wouldBlock =
    hit.intendedOutcome === "deny" || hit.intendedOutcome === "escalate";

  const enforced = opts.mode === "enforce";
  const effectiveOutcome = enforced ? hit.intendedOutcome : "monitor";

  return {
    intendedOutcome: hit.intendedOutcome,
    effectiveOutcome,
    enforced,
    mode: opts.mode,
    riskTier: tier,
    policyVersion: POLICY_VERSION,
    ruleId: hit.ruleId,
    reason: hit.reason,
    wouldBlock,
  };
}
