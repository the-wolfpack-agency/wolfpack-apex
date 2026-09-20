/**
 * Inline edge enforcement - the deterministic decision an edge acts on in the
 * request path. "Models advise, policy decides": the trust score + principal +
 * blocklist + reputation are the inputs; THIS function is the policy, and it is
 * pure and reproducible - the same signals + mode always yield the same verdict.
 *
 * This module is client-safe (no pg, no crypto): the operator board imports it to
 * show operators exactly what the edge WOULD do, and the edge endpoint imports it
 * to decide for real. One policy, both places, no drift.
 *
 * Enforcement mode mirrors OGIAM: "monitor" is shadow mode (decide + record the
 * would-be action, never actually block); "enforce" gates for real. The safe
 * default is monitor - nothing is blocked until a human switches it on.
 */
import type { TrustBand } from "@/lib/agent-operators-view";

export type EdgeAction = "allow" | "challenge" | "block" | "monitor";
export type EdgeMode = "monitor" | "enforce";
/** Local to keep this module independent of the principal module's merge order. */
export type EdgePrincipalStatus = "verified" | "claimed" | "absent";

/** The deterministic inputs to an edge decision. All are already-computed,
 *  non-PII signals about one operator. */
export interface EdgeSignals {
  /** On this workspace's operator blocklist (a human already blocked it). */
  blocked: boolean;
  /** The operator's deterministic trust band. */
  trustBand: TrustBand;
  /** A verified principal that stepped outside its granted scope. */
  mandateExceeded: boolean;
  /** Whether a delegation was verified / merely claimed / absent. */
  principalStatus: EdgePrincipalStatus;
  /** Known hostile to OTHER workspaces on the reputation network. */
  networkHostile: boolean;
}

export interface EdgeDecision {
  /** Effective action after the mode. "monitor" when not enforcing. */
  action: EdgeAction;
  /** What policy decided regardless of mode (the shadow-mode headline). */
  intended: Exclude<EdgeAction, "monitor">;
  /** True only in enforce mode when the intended action actually gates. */
  enforced: boolean;
  mode: EdgeMode;
  /** Stable id of the rule that fired (explainability). */
  ruleId: string;
  /** One plain sentence: why. */
  reason: string;
}

/**
 * Decide the edge action for one operator. Worst-first: a blocklisted operator or
 * a mandate violation blocks outright; a network-hostile actor blocks; a hostile
 * trust band blocks; an untrusted band or an unverifiable claimed principal is
 * challenged; everything else is allowed. Deterministic + pure.
 */
export function decideEdgeAction(signals: EdgeSignals, policy: { mode: EdgeMode }): EdgeDecision {
  let intended: Exclude<EdgeAction, "monitor">;
  let ruleId: string;
  let reason: string;

  if (signals.blocked) {
    intended = "block"; ruleId = "operator_blocklisted";
    reason = "Operator is on this workspace's blocklist.";
  } else if (signals.mandateExceeded) {
    intended = "block"; ruleId = "mandate_exceeded";
    reason = "A verified principal stepped outside its granted mandate - authorized access, abused.";
  } else if (signals.networkHostile) {
    intended = "block"; ruleId = "network_hostile";
    reason = "Operator is known hostile to other workspaces on the reputation network.";
  } else if (signals.trustBand === "hostile") {
    intended = "block"; ruleId = "trust_hostile";
    reason = "Trust band is hostile.";
  } else if (signals.trustBand === "untrusted") {
    intended = "challenge"; ruleId = "trust_untrusted";
    reason = "Trust band is untrusted; challenge before serving.";
  } else if (signals.principalStatus === "claimed") {
    intended = "challenge"; ruleId = "principal_unverifiable";
    reason = "Presented a delegation that did not verify; challenge to re-authenticate.";
  } else {
    intended = "allow"; ruleId = "default_allow";
    reason =
      signals.principalStatus === "verified"
        ? "Verified principal acting within its mandate; allowed."
        : "No hostile signal; allowed.";
  }

  const enforcing = policy.mode === "enforce";
  return {
    action: enforcing ? intended : "monitor",
    intended,
    enforced: enforcing && intended !== "allow",
    mode: policy.mode,
    ruleId,
    reason,
  };
}
