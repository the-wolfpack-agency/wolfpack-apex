/**
 * OGIAM: IAM for AI. Phase 0 type contracts.
 *
 * OGIAM is the deterministic authorization layer for AI actions. An AI agent
 * proposes a typed Action; the policy decision point (PDP) returns a Decision;
 * the Decision is recorded in a tamper-evident ledger. In Phase 0 the gate runs
 * in MONITOR mode: it records what it WOULD decide without blocking, so we get a
 * full evidence stream and tuning data before enforcing.
 *
 * The same Decision is both an IAM record (who/what was allowed to do what) and
 * a compliance artifact (signed evidence that policy was enforced). One event,
 * two buyers.
 */

/** What the policy decided, independent of enforcement mode. */
export type OgiamIntendedOutcome = "allow" | "deny" | "transform" | "escalate";

/** The effective outcome after applying the enforcement mode. In monitor mode
 *  it is always "monitor" (record only, never block). */
export type OgiamEffectiveOutcome = OgiamIntendedOutcome | "monitor";

export type OgiamEnforcementMode = "monitor" | "enforce";

export type OgiamRiskTier = "low" | "medium" | "high" | "critical";

/** The AI identity taking the action, and the human it acts for. The "owner
 *  for AGI": a human is always accountable for an AI principal. */
export interface OgiamPrincipal {
  kind: "ai_agent";
  /** Stable agent id. "instinct.assistant" for the human-driven assistant, or
   *  an agent principal id when an onboarded agent is acting as itself. */
  agent: string;
  /** The actor the action runs as. The agent id when an agent acts as itself,
   *  or the human's id for the assistant. */
  onBehalfOfUserId: string;
  onBehalfOfRole: string;
  workspaceId: string;
  /** The accountable human owner, when the actor is an onboarded agent (the
   *  owner for AGI). Absent for the human-driven assistant. */
  ownerUserId?: string;
}

/** Advisory signals from the policy information points (PIP). NEVER the gate;
 *  they are inputs the deterministic policy may consider. */
export interface OgiamSignals {
  /** PII (email, phone, ssn, card, iban, ip) found in the action parameters. */
  piiDetected?: boolean;
  /** A secret or API key shape found in the action parameters. */
  secretDetected?: boolean;
  /** 0..1 prompt-injection likelihood. Optional; a future PIP (Azure OpenAI)
   *  can populate this asynchronously. Advisory only. */
  injectionScore?: number;
}

/** A typed AI action: what the agent wants to do. Derived from the tool the
 *  assistant is about to run, so the schema stays DRY with the tool registry. */
export interface OgiamAction {
  /** The tool the agent is invoking (the capability surface). */
  tool: string;
  /** Capability the tool requires (from the tool definition). */
  capability: string;
  /** True when the action mutates state (a tool's requiresConfirmation). */
  isMutation: boolean;
  /** Where the action originated, e.g. "/assistant". */
  surface: string;
  /** Per-turn correlation id, joins the decision to the chat turn. */
  workflowId?: string;
  /** Canonical sha256 of the REDACTED parameters. The raw parameters never
   *  enter the ledger; only this hash and the redacted view do. */
  paramsHash: string;
  /** Advisory signals. */
  signals: OgiamSignals;
}

/** The PDP's decision about an action. Deterministic: the same action, policy
 *  version, and signals always yield the same decision. */
export interface OgiamDecision {
  /** What policy decided, regardless of mode. */
  intendedOutcome: OgiamIntendedOutcome;
  /** Effective outcome after the mode. "monitor" when not enforcing. */
  effectiveOutcome: OgiamEffectiveOutcome;
  /** True only when the mode is "enforce" and the decision actually gates. */
  enforced: boolean;
  mode: OgiamEnforcementMode;
  riskTier: OgiamRiskTier;
  /** Versioned policy id so a decision is reproducible against a known policy. */
  policyVersion: string;
  /** Stable id of the single rule that fired (explainability). */
  ruleId: string;
  /** Human-readable reason the rule fired. */
  reason: string;
  /** True when the intended outcome would have blocked the action (deny or
   *  escalate). The headline shadow-mode metric. */
  wouldBlock: boolean;
  /** The ledger seq the decision was recorded under, when the append-only
   *  write succeeded. Lets the caller link an action OUTCOME (the result) back
   *  to this decision (the input) without mutating the decision row. Absent
   *  when the ledger write was skipped (no DATABASE_URL) or failed. */
  recordedSeq?: number;
  /** Set true ONLY in enforce mode when the decision could not be written to the
   *  tamper-evident ledger, even after a retry. The PEP MUST block the action:
   *  no audit, no action. Never set in monitor mode. */
  unauditable?: boolean;
}
