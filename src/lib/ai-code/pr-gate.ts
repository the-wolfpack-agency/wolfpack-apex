/**
 * PR-gate: run the SAME deterministic gate the factory uses (assessChange) over
 * an arbitrary pull request's diff, and shape the verdict as a GitHub Check Run.
 *
 * This is the "govern any PR" surface. The diff can come from our own factory,
 * from GitHub Copilot's coding agent, or from a human: the gate does not care
 * who wrote it, because the rules live in the gate, not the model. Deterministic
 * (same diff in, same verdict out) and DRY (it reuses assessChange rather than
 * re-expressing the gate).
 *
 * A PR diff is real unified-diff text, so invariant evaluation runs in full
 * (unlike files-mode, which cannot derive a net dependency delta).
 */
import { assessChange, type ChangeAssessment } from "./assess";

export const PR_GATE_CHECK_NAME = "Secure Agent / gate";

export interface PrGateVerdict {
  assessment: ChangeAssessment;
  conclusion: "success" | "action_required";
  title: string;
  summary: string;
}

/** One-line reason for the blocking layer, for the check title. */
function reasonFor(a: ChangeAssessment): string {
  switch (a.blockedBy) {
    case "security":
      return `Security gate returned ${a.securityOutcome}`;
    case "invariant":
      return `Engineering invariant ${a.invariantRuleId}`;
    case "deep-scan":
      return `Deep scan found ${a.deepScanCritical} critical`;
    default:
      return "Passed every gate layer";
  }
}

/** Pure: turn a gate assessment into a Check Run verdict. */
export function assessmentToVerdict(a: ChangeAssessment): PrGateVerdict {
  const conclusion: PrGateVerdict["conclusion"] = a.handoffAllowed
    ? "success"
    : "action_required";
  const title = a.handoffAllowed
    ? "Passed the Secure Agent gate"
    : `Blocked: ${reasonFor(a)}`;
  const summary = [
    "**Secure Agent gate** (deterministic, model-agnostic)",
    "",
    `- Security: ${a.securityOutcome}`,
    `- Engineering invariant: ${a.invariantBlocked ? `blocked (${a.invariantRuleId})` : "clear"}`,
    `- Deep static scan: ${a.deepScanBlocking ? `blocked (${a.deepScanCritical} critical)` : "clear"}`,
    "",
    a.handoffAllowed
      ? "This change clears every rule. Safe to merge once a human approves."
      : `This change is blocked by the ${a.blockedBy} layer. Address it and push again; the gate re-runs automatically.`,
  ].join("\n");
  return { assessment: a, conclusion, title, summary };
}

export async function gatePullRequestDiff(diff: string): Promise<PrGateVerdict> {
  const assessment = await assessChange(diff);
  return assessmentToVerdict(assessment);
}
