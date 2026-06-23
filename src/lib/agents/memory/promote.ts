/**
 * Procedure promotion safety check (the AgenticQA-style adversarial gate before
 * a learned procedure becomes inheritable).
 *
 * A procedure is only safe to share if every step it contains is still allowed
 * under the CURRENT OGIAM policy. We re-derive each step's tool and re-decide it
 * in enforce mode: if any step would now be blocked (the tool became high-risk,
 * a mutation, or was removed since the procedure was learned), the procedure is
 * refused. This is what stops a poisoned or stale plan from propagating to other
 * agents: inheritance never lets an agent skip the gate.
 */

import { getToolByName } from "@/lib/assistant/tools/registry";
import { buildAction } from "@/lib/ogiam/action";
import { decide } from "@/lib/ogiam/policy";
import type { ProcedureStep } from "./types";

export interface PromotionVerdict {
  safe: boolean;
  reason: string | null;
}

export function verifyProcedureForPromotion(plan: ProcedureStep[]): PromotionVerdict {
  for (const step of plan) {
    // A step that matched no tool executed nothing; it carries no risk.
    if (!step.tool) continue;

    const tool = getToolByName(step.tool);
    if (!tool) {
      return { safe: false, reason: `tool "${step.tool}" no longer exists` };
    }

    const { action } = buildAction({
      tool: tool.name,
      capability: tool.capability,
      isMutation: Boolean(tool.requiresConfirmation),
      surface: "/agent",
      params: {},
    });
    const decision = decide(action, { mode: "enforce" });
    if (decision.wouldBlock) {
      return {
        safe: false,
        reason: `step "${step.instruction}" via ${step.tool} is now ${decision.intendedOutcome} (rule ${decision.ruleId})`,
      };
    }
  }
  return { safe: true, reason: null };
}
