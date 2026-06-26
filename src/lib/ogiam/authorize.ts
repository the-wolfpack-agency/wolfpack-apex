/**
 * OGIAM authorize: the single entrypoint a policy enforcement point (PEP) calls.
 *
 * An agent proposes an action; OGIAM decides and records the decision. In Phase
 * 0 the default mode is "monitor": the decision is computed and logged, but the
 * effective outcome is always "monitor" so nothing is blocked. The PEP can read
 * decision.enforced to know whether it must act on the outcome (false in monitor
 * mode, so the assistant proceeds exactly as before).
 *
 * This call is best effort and fast: the policy is a pure function (sub
 * millisecond) and the ledger write is swallowed on failure, so wiring OGIAM
 * into the hot path can never break or meaningfully slow the assistant.
 */

import { decide } from "./policy";
import { buildAction, type BuildActionInput } from "./action";
import { recordDecision } from "./ledger";
import type {
  OgiamDecision,
  OgiamEnforcementMode,
  OgiamPrincipal,
} from "./types";

export interface AuthorizeInput extends BuildActionInput {
  /** The AI identity and the human it acts for. */
  principal: OgiamPrincipal;
  /** Defaults to "monitor" in Phase 0. Graduating a capability to "enforce" is
   *  a configuration change, not a code change at the call site. */
  mode?: OgiamEnforcementMode;
}

export async function authorize(input: AuthorizeInput): Promise<OgiamDecision> {
  const mode: OgiamEnforcementMode = input.mode ?? "monitor";
  const { action, redactedParams } = buildAction(input);
  const decision = decide(action, { mode });

  // Record the decision. recordDecision never throws (best effort) and returns
  // null on failure. In the human MONITOR path that is fine: a ledger failure is
  // swallowed and the assistant proceeds exactly as before.
  let recorded = await recordDecision({
    principal: input.principal,
    action,
    decision,
    redactedParams,
  });

  // FAIL CLOSED ON UNAUDITABLE (enforce only). For a governed AGENT the audit IS
  // the guarantee: an action that cannot be written to the tamper-evident ledger
  // must not execute. Retry once for a transient failure, then mark the decision
  // unauditable and force a block, so the PEP refuses it - "no audit, no action",
  // the same integrity rule as "no authorization, no action". The MONITOR path
  // is deliberately untouched (it never blocks).
  if (!recorded && mode === "enforce") {
    recorded = await recordDecision({
      principal: input.principal,
      action,
      decision,
      redactedParams,
    });
    if (!recorded) {
      decision.unauditable = true;
      decision.wouldBlock = true;
    }
  }

  if (recorded) decision.recordedSeq = recorded.seq;

  return decision;
}
