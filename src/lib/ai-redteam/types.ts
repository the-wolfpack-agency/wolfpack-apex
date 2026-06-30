/**
 * Continuous AI red-team — types.
 *
 * A standing adversarial corpus run against the OGIAM gate: each attack is an
 * agent action a hostile prompt would try to drive (exfiltrate a secret, ride a
 * prompt injection into a mutation, abuse a high-risk tool, escalate privilege).
 * The gate MUST block every one. An attack the gate lets through is a VULN - a
 * policy regression caught before a client hits it. Deterministic and offline: it
 * reuses the real buildAction + decide path (no live model, no network, no cost),
 * so it is safe to run continuously on a schedule.
 *
 * This is the gate-facing red-team (LLM06/07/08 + injection-into-action). A live
 * prompt-surface red-team (LLM01 against a model endpoint) is a future adapter on
 * the same runner, gated by the pentest ownership authorization.
 */
import type { BuildActionInput } from "@/lib/ogiam/action";

/** OWASP-LLM-aligned category so a client report speaks the standard language. */
export type RedTeamCategory =
  | "LLM01_prompt_injection"
  | "LLM06_info_disclosure"
  | "LLM07_insecure_tool"
  | "LLM08_excessive_agency";

export interface RedTeamAttack {
  id: string;
  category: RedTeamCategory;
  technique: string;
  /** The adversarial action, run through the same gate path as a live dispatch. */
  input: BuildActionInput;
  /** Which policy rule SHOULD stop it (for the report + explainability). */
  why: string;
}

/** An attack the gate did NOT block: the recorded vulnerability. */
export interface RedTeamFinding {
  attackId: string;
  category: RedTeamCategory;
  technique: string;
  /** What the gate actually returned (allow = it got through). */
  outcome: string;
  ruleId: string;
}

export interface RedTeamReport {
  attacksRun: number;
  blocked: number;
  /** Attacks the gate failed to block. Empty is the healthy state. */
  vulns: RedTeamFinding[];
  /** blocked / attacksRun, 0..1. */
  passRate: number;
  byCategory: Record<string, { run: number; blocked: number }>;
}
