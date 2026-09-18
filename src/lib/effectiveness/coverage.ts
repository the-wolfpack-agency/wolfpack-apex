/**
 * Capture coverage - the machine-checked "no execution data lost" guarantee.
 *
 * THE DIRECTIVE THIS ENCODES. Every governed execution should be consumed to
 * benefit the system: as marketing evidence, as fine-tune ground truth, and as
 * COGS metering. That is easy to say and easy to let slip - a new enforcing
 * control ships, its decisions flow to the audit log, and nobody wires its
 * execution stream into the evidence rollup, so a real, defensible number
 * quietly never gets counted. This registry makes that impossible to do
 * silently: every ENFORCING control on the ladder must be classified here, and
 * the ratchet test fails the build if a new one appears unclassified.
 *
 * HONEST BY CONSTRUCTION. A control is only marked `capturedBy` a source when
 * its executions actually reach that source today (verified against the rollup
 * and dataset readers). A control that is enforced but whose execution stream is
 * NOT yet aggregated into the evidence pipeline is a `gap`, counted by a
 * shrink-only ratchet - the same mechanism the control ladder uses for its own
 * enforcement gaps. A control that emits no per-action record to capture (a
 * structural posture fact, not an event) is `noPerActionRecord` with a reason.
 * Nothing here claims capture it does not have.
 */

import { CONTROL_LADDER, isEnforcing, type ControlEntry } from "@/lib/governance/control-ladder";

/** The evidence-pipeline sources an execution stream can land in. */
export type CaptureSource = "governance" | "secure_agent" | "forcefield" | "cost";

export interface CaptureClassification {
  /** Matches a ControlEntry.id on the ladder. */
  id: string;
  /** Set when this control's executions reach an effectiveness source today. */
  capturedBy?: CaptureSource;
  /** Set when the control emits no per-action record to capture (posture, not
   *  an event stream) - with the reason it is not an omission. */
  noPerActionRecord?: string;
  /** Set when the control IS enforced but its execution stream is not yet
   *  aggregated into the evidence pipeline. A tracked, shrink-only gap. */
  gap?: string;
}

/* One classification per ENFORCING ladder control. Grounded in what the rollup
   and dataset readers actually consume as of authoring:
     - governance  <- OGIAM gate decisions (recordDecision -> ogiam_decisions,
                       read by listDecisions)
     - secure_agent<- ai-code review store
     - forcefield  <- canary-trip ledger
     - cost        <- metered AI spend (v_ai_cost_daily) */
export const CAPTURE_MAP: CaptureClassification[] = [
  // Captured today.
  { id: "ogiam-authorize-agent", capturedBy: "governance" },
  { id: "ogiam-unauditable-block", capturedBy: "governance" },
  { id: "code-security-gate", capturedBy: "secure_agent" },
  { id: "forcefield-containment", capturedBy: "forcefield" },
  { id: "budget-ceiling-unconfigured", capturedBy: "cost" },
  {
    id: "agent-write-approval",
    capturedBy: "governance",
    // A held write surfaces as an "escalate" decision on the OGIAM ledger, so
    // the approval-gated actions are counted in the governance rollup.
  },

  // Structural / posture controls: nothing per-action to aggregate.
  {
    id: "agent-revocation",
    noPerActionRecord:
      "Revocation is an identity-state change, not an agent execution; the effect (a revoked agent's calls are refused) is a structural fact, not an event stream to roll up.",
  },
  {
    id: "byo-key-confidentiality",
    noPerActionRecord:
      "Confidentiality is a structural property of key handling (router-only plaintext), not a per-action event.",
  },
  {
    id: "onbehalf-token",
    noPerActionRecord:
      "The token itself is a credential shape; each action that USES it flows through the gate and is already counted under governance.",
  },

  // Enforced, but the execution stream is not yet in the evidence pipeline.
  // Shrink-only: wire these into a source and delete the gap.
  {
    id: "capability-gate",
    gap: "Route- and tool-level capability denials are enforced and recorded to auth analytics, but not yet aggregated into the effectiveness rollup.",
  },
  {
    id: "connector-scope",
    gap: "Connector-scope denials are enforced but not yet surfaced as an effectiveness metric.",
  },
  {
    id: "agent-ceiling",
    gap: "Operations-per-hour ceiling trips are enforced but not yet aggregated into effectiveness.",
  },
  {
    id: "conduct-self-tamper",
    gap: "Conduct-gate denials are recorded to the audit trail but not yet aggregated into the effectiveness rollup as their own metric.",
  },
];

/** The enforcing controls whose execution stream is not yet captured. */
export function captureGaps(): CaptureClassification[] {
  return CAPTURE_MAP.filter((c) => c.gap);
}

/** The set of ladder ids that must be classified: every enforcing control. */
export function enforcingLadderIds(): string[] {
  return CONTROL_LADDER.filter((e: ControlEntry) => isEnforcing(e)).map((e) => e.id);
}
