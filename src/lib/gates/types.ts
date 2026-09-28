/**
 * Agent Gate - the deployable primitive.
 *
 * A gate is one narrow, safe checkpoint in an AI workflow: input in, a
 * DETERMINISTIC verdict out, with an optional model invocation WHEN the gate
 * needs generation or judgment. Enforcement lives in the gate, not the model, so
 * a gate is model-agnostic - a client points their own LLM at it. Each gate is
 * self-contained and deployable to its own endpoint; a client can adopt a single
 * gate or chain the whole workflow. Chaining gates mimics how a human team hands
 * off work (author -> review -> fix -> deploy), one teammate per gate.
 *
 * Two properties are first-class, not afterthoughts:
 *  - COMPLIANCE: every gate runs under the client's CompliancePolicy, and the
 *    framework (not the gate author) enforces the data rules - a gate physically
 *    cannot send data to a model the policy forbids.
 *  - TRANSPARENCY: every result carries a client-facing record of what was
 *    checked, what data was seen, which model (if any) was invoked, and which of
 *    the client's compliance frameworks were applied. Good products don't hide;
 *    transparency is what speeds adoption.
 */

/** The four verdicts. AUTO_FIX is what turns a checkpoint into an autonomous
 *  relay (vs a gate that only ever stops for a human): the flow keeps moving
 *  unless a human is genuinely the intended reviewer. */
export type GateVerdict = "allow" | "auto_fix" | "require_human" | "deny";

/** A model the gate MAY invoke for generation/judgment. Model-agnostic: the
 *  client's configured model is supplied at call time; the gate never hardcodes
 *  one. The framework wraps this to enforce the client's data policy before any
 *  prompt leaves. */
export interface GateAgent {
  complete(req: { prompt: string; feature: string }): Promise<{ content: string; model_used?: string | null }>;
}

/** The client's compliance + data-handling profile. The gate tailors its
 *  behavior to THIS client and reports it transparently. */
export interface CompliancePolicy {
  /** Frameworks the client operates under, e.g. ["SOC2","ISO27001","GDPR"].
   *  Reported in every result's transparency record. */
  frameworks: string[];
  /** Where the client's data must stay, e.g. "us" | "eu". Advisory metadata
   *  surfaced to the client; routing enforcement is the deployment's job. */
  dataResidency?: string;
  /** Whether gate input may be sent to a model at all: never, only after
   *  redaction, or in full. The framework enforces this - a gate cannot bypass it. */
  allowModelData: "none" | "redacted" | "full";
  /** LITERAL terms stripped from any prompt before it reaches the model (applied
   *  when allowModelData is "redacted"). Matched as literal substrings, never as a
   *  regex - a client-built regex is a ReDoS risk. The default secret/PII scrub
   *  runs regardless; these are extra client-specific terms (codenames, ids). */
  redactions?: string[];
  /** How long the client wants gate records retained (surfaced, enforced by the
   *  deployment's retention job). */
  retentionDays?: number;
}

/** A sensible default when a client has configured nothing yet: deterministic
 *  only, no data to any model, no frameworks asserted. Safe by default. */
export const DEFAULT_COMPLIANCE_POLICY: CompliancePolicy = {
  frameworks: [],
  allowModelData: "none",
  redactions: [],
};

export interface GateFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  detail: string;
}

/** What the client SEES - always present, verbatim in the API response. */
export interface GateTransparency {
  /** Every deterministic check the gate performed, by name. */
  checksRun: string[];
  /** Plain description of what the gate looked at (and what it did NOT forward). */
  dataSeen: string;
  /** Which model was invoked, or null when the decision was purely deterministic. */
  modelInvoked: string | null;
  /** Which of the client's compliance frameworks were applied this run. */
  frameworksApplied: string[];
  /** Plain-language why-this-verdict. */
  explanation: string;
}

/** The canonical audit fields for the hash-chained ledger. Persisted by the
 *  caller (route), computed by the framework so it is uniform across gates. */
export interface GateAuditPayload {
  gate: string;
  verdict: GateVerdict;
  ruleId: string;
  reason: string;
  workspaceId: string;
  actorId: string;
}

export interface GateResult<O = unknown> {
  verdict: GateVerdict;
  /** Typed handoff to the next gate in a chain (e.g. the authored diff). */
  output?: O;
  findings: GateFinding[];
  reason: string;
  transparency: GateTransparency;
  audit: GateAuditPayload;
  /** Set by a gate that took an IRREVERSIBLE action (a commit) and therefore
   *  recorded its decision to the tamper-evident ledger ITSELF, before acting
   *  (fail-closed: no audit, no action). The route then skips the post-hoc audit
   *  to avoid a duplicate row. Absent for gates whose decision the route audits. */
  recordedSeq?: number;
}

export interface GateContext {
  workspaceId: string;
  actorId: string;
  /** The client's model, invoked only if the gate needs generation/judgment.
   *  The framework replaces this with a policy-enforced wrapper before the gate
   *  sees it (see run-gate.ts) - a gate always receives an agent it is allowed to
   *  use, or one that refuses, per the policy. */
  agent?: GateAgent;
  policy: CompliancePolicy;
}

export interface GateDefinition<I, O = unknown> {
  /** Stable, URL-safe name; also the endpoint segment (/api/gate/<name>). */
  name: string;
  /** Entitlement the client's workspace must hold to run this gate. */
  entitlement?: string;
  /** One-line, client-facing description of what this gate guarantees. */
  purpose: string;
  /** DETERMINISTIC-first evaluation. May call ctx.agent for generation/judgment,
   *  but the verdict must be decided by deterministic logic - the model advises,
   *  the gate decides. Must always populate transparency. */
  evaluate(input: I, ctx: GateContext): Promise<GateResult<O>>;
}
