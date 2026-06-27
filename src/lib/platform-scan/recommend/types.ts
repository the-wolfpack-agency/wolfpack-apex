/**
 * AutomationRecommendation: a concrete, gate-governed PROPOSAL the agent derives
 * from a target's SystemProfile + open findings. It NEVER executes anything;
 * execution stays behind the existing capture -> approve -> execute gate. Each
 * recommendation is traceable to a deterministic rule + its evidence, so a human
 * (and the gate) can trust why it was proposed.
 */
export type RecPriority = "critical" | "high" | "medium" | "low";
export type RecCategory =
  | "security_remediation"
  | "integration_automation"
  | "quality"
  | "operational";
export type RecStatus = "proposed" | "accepted" | "dismissed" | "implemented";

export interface AutomationRecommendation {
  /** Stable dedup identity within a (workspace, platform), e.g. "security_remediation:headers". */
  key: string;
  category: RecCategory;
  priority: RecPriority;
  title: string;
  /** Why this is proposed (the rule's reasoning). */
  rationale: string;
  /** The concrete action an operator/agent would take. */
  suggestedAction: string;
  /** What triggered it, e.g. "finding:security" | "profile:integration:Stripe" | "posture". */
  source: string;
  evidence: Record<string, string | number | boolean | null>;
}
