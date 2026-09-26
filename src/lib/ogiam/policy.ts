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

/**
 * A single deterministic policy rule. `test` is a PURE predicate over the action
 * (and its precomputed risk tier): it returns a hit when the rule fires, or null
 * to fall through to the next rule. Rules are evaluated in array order and the
 * first hit wins, so ordering encodes precedence. Every rule ships with a
 * "prove it fails" test (see policy-invariants.test.ts) so a rule that stops
 * firing is caught, not silently lost.
 */
export interface PolicyRule {
  id: string;
  /** One line, reviewable: what this rule protects and why. */
  rationale: string;
  test: (action: OgiamAction, tier: OgiamRiskTier) => Omit<RuleHit, "ruleId"> | null;
}

/**
 * The ordered rule set, as data. Adding an engineering invariant is adding an
 * entry here plus its prove-it-fails test - not editing a control-flow chain.
 * The decidable-invariant rules act only when their signal is present, so an
 * action that does not carry that fact is unaffected by them.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  {
    id: "R-SECRET-DENY",
    rationale: "A credential in the parameters is never allowed to flow through an action.",
    test: (a) =>
      a.signals.secretDetected
        ? { reason: "a secret or credential was detected in the action parameters", intendedOutcome: "deny" }
        : null,
  },
  {
    id: "R-INJECTION-ESCALATE",
    rationale: "A strong injection signal on a state-changing action means a human decides.",
    test: (a) =>
      a.isMutation &&
      typeof a.signals.injectionScore === "number" &&
      a.signals.injectionScore >= INJECTION_ESCALATE_THRESHOLD
        ? { reason: "a likely prompt injection is driving a state-changing action", intendedOutcome: "escalate" }
        : null,
  },
  {
    id: "R-DEPLOY-ONCE-DENY",
    rationale: "Scalable deployment: a change must deploy once. Deploying more than once is a non-scalable per-target process and fails.",
    test: (a) =>
      typeof a.signals.deploymentCount === "number" && a.signals.deploymentCount > 1
        ? {
            reason: `the change would deploy ${a.signals.deploymentCount} times; the deploy-once invariant requires a single, central deployment`,
            intendedOutcome: "deny",
          }
        : null,
  },
  {
    id: "R-CI-INCOMPLETE-DENY",
    rationale: "Logical CI: a change may not reach a human reviewer until CI has fully passed.",
    test: (a) =>
      a.isMutation && a.signals.ciComplete === false
        ? { reason: "CI has not fully passed; a change may not be handed to a human reviewer until it is green", intendedOutcome: "deny" }
        : null,
  },
  {
    id: "R-DEPENDENCY-ADDED-ESCALATE",
    rationale: "A new runtime dependency is a last resort; adding one requires human sign-off, not silent acceptance.",
    test: (a) =>
      typeof a.signals.dependencyDelta === "number" && a.signals.dependencyDelta > 0
        ? {
            reason: `the change adds ${a.signals.dependencyDelta} runtime dependency(ies); a new dependency is a last resort and requires human sign-off`,
            intendedOutcome: "escalate",
          }
        : null,
  },
  {
    id: "R-PENTEST-SCOPED-ALLOW",
    // By the time a pentest action reaches here the harness has already verified an
    // admin-issued scope token, budget, kill switch, allowed host + technique, and
    // the SSRF floor. The gate still RECORDS every pentest decision. A secret
    // (above) still denies and a strong injection (above) still escalates.
    rationale: "Authorized active pentest, bounded by an issued scope token + the harness.",
    test: (a) =>
      a.capability === "platform.pentest"
        ? { reason: "authorized active pentest, bounded by an issued scope token + the harness", intendedOutcome: "allow" }
        : null,
  },
  {
    id: "R-PII-OUTBOUND-TRANSFORM",
    rationale: "PII heading outbound is redacted (transformed), not blocked.",
    test: (a) =>
      a.signals.piiDetected && matchesAny([a.capability, a.tool], OUTBOUND_SEND_FRAGMENTS)
        ? { reason: "PII is present in an outbound action and must be redacted first", intendedOutcome: "transform" }
        : null,
  },
  {
    id: "R-HIGHRISK-MUTATION-ESCALATE",
    rationale: "High-risk mutations (money, send, delete, admin) require explicit human approval.",
    test: (_a, tier) =>
      tier === "high"
        ? { reason: "a high-risk state-changing action requires human approval", intendedOutcome: "escalate" }
        : null,
  },
  {
    id: "R-MUTATION-ALLOW",
    // A medium-risk mutation is allowed: the principal only reached this tool
    // because the role gate authorized it, and OGIAM reserves escalation for
    // HIGH-risk actions and denial for secrets. This lets an agent do its
    // authorized job while the dangerous actions are still stopped.
    rationale: "A state-changing action within the principal's authorized role.",
    test: (a) =>
      a.isMutation
        ? { reason: "a state-changing action within the principal's authorized role", intendedOutcome: "allow" }
        : null,
  },
  {
    id: "R-DEFAULT-ALLOW",
    rationale: "Read-only, low risk: allowed. The always-matches terminal rule.",
    test: () => ({ reason: "a read-only action within policy", intendedOutcome: "allow" }),
  },
];

/** Evaluate the ordered rule set. First match wins. Always returns a hit
 *  (the final default rule allows). */
function evaluateRules(action: OgiamAction, tier: OgiamRiskTier): RuleHit {
  for (const rule of POLICY_RULES) {
    const hit = rule.test(action, tier);
    if (hit) return { ruleId: rule.id, ...hit };
  }
  // Unreachable: R-DEFAULT-ALLOW always matches. Fail closed if a future edit
  // removes it, rather than returning undefined.
  return { ruleId: "R-NO-RULE-DENY", reason: "no policy rule matched", intendedOutcome: "deny" };
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
