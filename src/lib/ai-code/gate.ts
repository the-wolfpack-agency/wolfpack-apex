/**
 * Deterministic code gate. Pure: the verdict is a reproducible function of the
 * findings' worst severity, mirroring the OGIAM action gate (models propose,
 * policy decides). critical blocks the merge, high escalates to a human, anything
 * less is allowed with the findings attached as review notes. The rule that fired
 * is always named, so a blocked merge is explainable.
 */
import type { AiCodeFinding, CodeFindingSeverity, CodeGateVerdict } from "./types";

const ORDER: Record<CodeFindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function decideCodeGate(findings: AiCodeFinding[]): CodeGateVerdict {
  let highest: CodeFindingSeverity | "none" = "none";
  for (const f of findings) {
    if (highest === "none" || ORDER[f.severity] > ORDER[highest]) highest = f.severity;
  }
  switch (highest) {
    case "critical":
      return {
        outcome: "block",
        highestSeverity: highest,
        reason: "a critical-severity risk (e.g. a hardcoded secret) was introduced; the merge is blocked",
        ruleId: "C-CRITICAL-BLOCK",
      };
    case "high":
      return {
        outcome: "escalate",
        highestSeverity: highest,
        reason: "a high-severity risk requires human review before merge",
        ruleId: "C-HIGH-ESCALATE",
      };
    case "medium":
    case "low":
      return {
        outcome: "allow",
        highestSeverity: highest,
        reason: "only low/medium advisory findings; allowed with the findings as review notes",
        ruleId: "C-ADVISORY-ALLOW",
      };
    default:
      return {
        outcome: "allow",
        highestSeverity: "none",
        reason: "no security findings in the AI-authored diff",
        ruleId: "C-CLEAN-ALLOW",
      };
  }
}
