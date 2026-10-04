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
import { parseAddedLines } from "./detect";
import { applyDenyRules, touchesPolicyProtectedPaths, DEFAULT_CODE_GATE_POLICY, type CodeGatePolicy } from "./policy";
import { loadCodeGatePolicy } from "./policy-store";
import type { ScanFinding } from "@/lib/platform-scan/types";

export const PR_GATE_CHECK_NAME = "Secure Agent / gate";

/** The per-org policy layer's result for a PR diff. */
export interface PrGatePolicyResult {
  /** Deny-rule hits against the diff's added lines. */
  findings: ScanFinding[];
  /** How many of those are blocking (critical or high). */
  blockingFindings: number;
  /** Protected paths (org policy) the PR touches - require a human even if clean. */
  protectedPaths: string[];
}

export interface PrGateVerdict {
  assessment: ChangeAssessment;
  conclusion: "success" | "action_required";
  title: string;
  summary: string;
  /** Present when an org policy was applied (omitted for the default/empty policy). */
  policy?: PrGatePolicyResult;
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

/** True when the org policy is empty (no rules, no protected paths) - a no-op. */
function policyIsEmpty(p: CodeGatePolicy): boolean {
  return p.denyRules.length === 0 && p.protectedPaths.length === 0;
}

/**
 * Apply a client's code-gate policy to a PR diff. Pure. Runs the org deny-rules
 * against the diff's ADDED lines (so a forbidden pattern a PR introduces is
 * caught, not a pre-existing one) and lists the protected paths it touches. The
 * policy can only ADD blocking reasons; it never clears a built-in gate layer.
 */
export function evaluatePrPolicy(diff: string, policy: CodeGatePolicy): PrGatePolicyResult {
  if (policyIsEmpty(policy)) return { findings: [], blockingFindings: 0, protectedPaths: [] };
  const added = parseAddedLines(diff);
  const addedByFile: Record<string, string> = {};
  for (const a of added) addedByFile[a.file] = addedByFile[a.file] ? `${addedByFile[a.file]}\n${a.text}` : a.text;
  const findings = applyDenyRules(addedByFile, policy);
  const blockingFindings = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const protectedPaths = touchesPolicyProtectedPaths(Object.keys(addedByFile), policy);
  return { findings, blockingFindings, protectedPaths };
}

/**
 * Fold a policy result into a base verdict. A blocking deny-finding or a touched
 * protected path forces action_required even when the built-in gate allowed.
 * Pure.
 */
export function applyPolicyToVerdict(base: PrGateVerdict, policy: PrGatePolicyResult): PrGateVerdict {
  const policyBlocks = policy.blockingFindings > 0 || policy.protectedPaths.length > 0;
  if (!policyBlocks) {
    // Still record the (clean) policy layer in the summary so the check shows it ran.
    const summary = `${base.summary}\n- Org policy: clear`;
    return { ...base, summary, policy };
  }
  const reasons: string[] = [];
  if (policy.blockingFindings > 0) reasons.push(`${policy.blockingFindings} org-policy violation${policy.blockingFindings === 1 ? "" : "s"}`);
  if (policy.protectedPaths.length > 0) reasons.push(`${policy.protectedPaths.length} protected path${policy.protectedPaths.length === 1 ? "" : "s"} touched`);
  const title = base.conclusion === "action_required" ? base.title : `Blocked: ${reasons.join(" + ")}`;
  const lines = [
    base.summary,
    `- Org policy: **blocked** (${reasons.join("; ")})`,
  ];
  for (const f of policy.findings.slice(0, 10)) lines.push(`  - ${f.severity.toUpperCase()} ${f.title} (${f.route})`);
  for (const p of policy.protectedPaths.slice(0, 10)) lines.push(`  - protected path touched: ${p}`);
  return { ...base, conclusion: "action_required", title, summary: lines.join("\n"), policy };
}

export async function gatePullRequestDiff(diff: string, opts: { workspaceId?: string } = {}): Promise<PrGateVerdict> {
  const assessment = await assessChange(diff);
  const base = assessmentToVerdict(assessment);
  if (!opts.workspaceId) return base;
  // Load the workspace's policy (never throws; degrades to the empty default,
  // which is a no-op - the gate is never weakened by a policy-load failure).
  const policy = await loadCodeGatePolicy(opts.workspaceId).catch(() => DEFAULT_CODE_GATE_POLICY);
  if (policyIsEmpty(policy)) return base;
  return applyPolicyToVerdict(base, evaluatePrPolicy(diff, policy));
}
