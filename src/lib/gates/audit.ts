/**
 * Persist a gate decision to the OGIAM hash-chained ledger. A gate verdict IS an
 * authorization decision (allow / transform / escalate / deny), so it maps
 * cleanly onto the tamper-evident ledger the platform already runs - the client
 * can verify the chain of every safety decision the gate made on their behalf.
 *
 * Never throws: a failed ledger write returns null (the decision still happened;
 * only its persistence was skipped), matching recordDecision's own contract.
 */
import { createHash } from "node:crypto";
import { recordDecision } from "@/lib/ogiam/ledger";
import type { OgiamIntendedOutcome, OgiamRiskTier } from "@/lib/ogiam/types";
import type { GateResult, GateContext, GateVerdict } from "./types";

const GATE_POLICY_VERSION = "gate-v1";

/** verdict -> the OGIAM outcome it corresponds to. auto_fix is a transform (the
 *  gate changes the artifact); require_human is an escalation; deny is a deny. */
function intended(v: GateVerdict): OgiamIntendedOutcome {
  switch (v) {
    case "allow": return "allow";
    case "auto_fix": return "transform";
    case "require_human": return "escalate";
    case "deny": return "deny";
  }
}

function riskTier(v: GateVerdict): OgiamRiskTier {
  switch (v) {
    case "deny": return "critical";
    case "require_human": return "high";
    case "auto_fix": return "medium";
    case "allow": return "low";
  }
}

/** A safe, bounded redacted view of the gate input for the ledger (never raw
 *  PII/secrets - only the shape + size). */
function redactInput(input: unknown): string {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    return `gate-input:${s.length}chars`;
  } catch {
    return "gate-input:unserializable";
  }
}

export interface GateAuditResult {
  /** The ledger seq this decision was recorded under, or null when persistence
   *  was skipped (no DATABASE_URL) or failed. */
  recordedSeq: number | null;
}

export async function recordGateDecision(
  gateName: string,
  result: GateResult,
  ctx: GateContext,
  input: unknown,
): Promise<GateAuditResult> {
  const redacted = redactInput(input);
  const paramsHash = createHash("sha256").update(redacted).digest("hex");
  const secretFinding = result.findings.some((f) => f.id === "security");

  const recorded = await recordDecision({
    principal: {
      kind: "ai_agent",
      agent: `gate.${gateName}`,
      onBehalfOfUserId: ctx.actorId,
      onBehalfOfRole: "gate-client",
      workspaceId: ctx.workspaceId,
    },
    action: {
      tool: `gate.${gateName}`,
      capability: "gate.run",
      isMutation: result.verdict === "auto_fix",
      surface: "/api/gate",
      paramsHash,
      signals: { secretDetected: secretFinding },
    },
    decision: {
      intendedOutcome: intended(result.verdict),
      effectiveOutcome: intended(result.verdict),
      enforced: result.verdict !== "allow",
      mode: "enforce",
      riskTier: riskTier(result.verdict),
      policyVersion: GATE_POLICY_VERSION,
      ruleId: result.audit.ruleId,
      reason: result.reason,
      wouldBlock: result.verdict === "deny" || result.verdict === "require_human",
    },
    redactedParams: redacted,
  }).catch(() => null);

  return { recordedSeq: recorded?.seq ?? null };
}
