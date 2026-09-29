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
export const POLICY_VERSION = "ogiam-2026-06-24.2";

/** Injection score at or above which a mutation is escalated to critical. */
export const INJECTION_CRITICAL_THRESHOLD = 0.8;

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
  "deploy",
  "promote",
  "publish",
  "repository",
  "rename",
  "domain",
  "dns",
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
  if (
    action.isMutation &&
    typeof action.signals.injectionScore === "number" &&
    action.signals.injectionScore >= INJECTION_CRITICAL_THRESHOLD
  ) {
    return "critical";
  }
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
      a.signals.injectionScore >= INJECTION_CRITICAL_THRESHOLD
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
    rationale: "Pentest actions are allowed if they meet pre-verified scope and safety criteria.",
    test: () => null, // Placeholder for pentest-specific logic
  },
];