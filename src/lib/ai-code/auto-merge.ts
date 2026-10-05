/**
 * Auto-merge POLICY for factory / ci-autofix PRs (the decision, not the effect).
 *
 * Merging to main auto-deploys to prod - the irreversible authorization step - so
 * the product's default is a human approves the merge (the ci-fix loop stops at
 * `merge_ready`). This policy decides the ONE narrow case where that human step may
 * be automated: the low-risk, fully-verified tail. It is deliberately conservative
 * and AND-gated - every condition must hold:
 *
 *   - CI fully green         (the loop's merge_ready guarantee; all required checks pass)
 *   - gate verdict = allow   (not escalate/block - no finding a human must weigh)
 *   - no sensitive surface   (no migration / auth / crypto / gate / CSP / infra change)
 *   - tests present          (the change carries its own verification)
 *
 * Anything else keeps the human merge gate. Pure: the caller supplies the four
 * signals (all already computed elsewhere - gate verdict, touchesSecuritySurface,
 * the diff's file list) and reads the decision. The EFFECT (enable native GitHub
 * auto-merge) is a separate, flag-gated step wired at merge_ready; this never
 * merges anything by itself.
 *
 * Flag-gated + dark by default: enablement callers must check autoMergeEnabled()
 * first, so turning it on is an explicit operator decision (per-deployment knob).
 */

/** Dark by default. An operator enables with AI_CODE_AUTO_MERGE=on|true|1. */
export function autoMergeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(on|true|1)$/i.test((env.AI_CODE_AUTO_MERGE ?? "").trim());
}

export interface AutoMergeSignals {
  /** All required checks are green (the ci-fix loop's merge_ready state). */
  ciGreen: boolean;
  /** The deterministic code gate's verdict on the change. */
  gateOutcome: "allow" | "escalate" | "block";
  /** The change touches a protected surface (migration/auth/crypto/gate/CSP/infra). */
  touchesSensitiveSurface: boolean;
  /** The change includes at least one test file (carries its own verification). */
  hasTests: boolean;
}

export interface AutoMergeDecision {
  eligible: boolean;
  /** Human-readable rationale (observability; recorded on the run). */
  reason: string;
}

/** Decide whether a PR may be auto-merged. Conservative AND-gate; pure. */
export function autoMergeEligible(s: AutoMergeSignals): AutoMergeDecision {
  if (!s.ciGreen) return { eligible: false, reason: "CI is not fully green" };
  if (s.gateOutcome !== "allow") return { eligible: false, reason: `gate verdict is '${s.gateOutcome}', not 'allow' (a human must weigh it)` };
  if (s.touchesSensitiveSurface) return { eligible: false, reason: "change touches a sensitive surface (migration/auth/crypto/gate/CSP/infra) - human authorizes" };
  if (!s.hasTests) return { eligible: false, reason: "change carries no tests - human authorizes" };
  return { eligible: true, reason: "low-risk tail: CI green + gate allow + no sensitive surface + tests present" };
}
