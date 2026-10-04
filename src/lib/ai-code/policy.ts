/**
 * Policy-as-code for the code gate - the enterprise wedge. A client codifies
 * THEIR OWN engineering/security standards on top of the built-in gate: extra
 * protected paths (human review when touched) and extra deny rules (forbidden
 * content), enforced + audited like any other finding.
 *
 * SAFETY: ADDITIVE-ONLY by design. A policy can only TIGHTEN the gate (add
 * controls); it can NEVER disable a built-in rule or lower a severity. Weakening
 * the gate is itself a security-surface change that must go through human review,
 * so the configurable layer is deliberately restricted to making the gate
 * stricter. Default = empty = identical to today (zero regression).
 */
import type { ScanFinding, ScanSeverity } from "@/lib/platform-scan/types";

export interface CodeGateDenyRule {
  /** Regex source tested against each added/authored line. */
  pattern: string;
  flags?: string;
  severity: ScanSeverity;
  title: string;
  detail?: string;
}
export interface CodeGatePolicy {
  /** Extra security-critical path regex sources: a change touching them needs
   *  human review (ADDITIVE to the built-in security surface). */
  protectedPaths: string[];
  /** Extra forbidden-content rules (ADDITIVE to the built-in detectors). */
  denyRules: CodeGateDenyRule[];
}

export const DEFAULT_CODE_GATE_POLICY: CodeGatePolicy = { protectedPaths: [], denyRules: [] };

/** Compile a client regex safely; a malformed pattern is skipped, never thrown. */
function safeRegex(src: string, flags?: string): RegExp | null {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

/** Findings from a client's deny rules over the authored files. Pure + additive. */
export function applyDenyRules(files: Record<string, string>, policy: CodeGatePolicy): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const rule of policy.denyRules) {
    const re = safeRegex(rule.pattern, rule.flags);
    if (!re) continue;
    for (const [path, content] of Object.entries(files)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({
            route: `${path}:${i + 1}`,
            severity: rule.severity,
            category: "security",
            title: `Org policy: ${rule.title}`,
            detail: rule.detail ?? "A client-defined code-gate policy rule flagged this line.",
            evidence: { path, line: i + 1, rule: rule.title, match: lines[i].trim().slice(0, 120) },
          });
          break; // one finding per line per rule
        }
      }
    }
  }
  return out;
}

/** Extra security-surface matchers from the policy's protected paths. */
export function policyProtectedPaths(policy: CodeGatePolicy): RegExp[] {
  return policy.protectedPaths.map((p) => safeRegex(p)).filter((r): r is RegExp => r !== null);
}

/** The protected paths a change touches under the ORG policy (additive to the
 *  built-in security surface). */
export function touchesPolicyProtectedPaths(paths: readonly string[], policy: CodeGatePolicy): string[] {
  const res = policyProtectedPaths(policy);
  return res.length === 0 ? [] : paths.filter((p) => res.some((re) => re.test(p)));
}
