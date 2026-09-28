/**
 * The chain runner - composes Agent Gates into one workflow that mimics a human
 * team's handoffs (author -> review -> fix -> ... -> human -> deploy), and keeps
 * going UNLESS a human is genuinely the intended gate.
 *
 * It is a deterministic state machine over gate verdicts:
 *   allow          -> advance to the next gate (carry its output forward)
 *   auto_fix       -> a gate changed state (e.g. committed a fix); PAUSE as
 *                     "fixing" - the caller re-runs the async work (CI) and
 *                     re-invokes the chain, which re-runs from the top (gates are
 *                     idempotent reads; ci-autofix re-reads the now-updated CI).
 *   require_human  -> PAUSE as "awaiting_human" - the one intended stop for a
 *                     passing flow (e.g. the production-deploy approval).
 *   deny           -> STOP as "denied" (a hard, deterministic block).
 *
 * The async waits (CI, a preview deploy) are the caller's job - a poller or
 * webhook re-invokes runChain when the awaited state settles. That keeps this
 * runner pure and testable, and lets a single step never dead-end the workflow:
 * it either advances, self-heals, or stops for a reason the client can see.
 */
import { runGate } from "./run-gate";
import type { GateContext, GateDefinition, GateVerdict } from "./types";

export interface ChainStep {
  gate: GateDefinition<unknown, unknown>;
  /** Derive this gate's input from the previous allow's output (or fixed params
   *  the caller closed over). */
  input: (priorOutput: unknown) => unknown;
}

export type ChainStatus = "completed" | "awaiting_human" | "fixing" | "denied";

export interface ChainStepRecord {
  gate: string;
  verdict: GateVerdict;
  reason: string;
}

export interface ChainRunResult {
  status: ChainStatus;
  /** Every gate that ran this pass, in order - the client-facing trail of what
   *  happened and why (each gate's own transparency is fetched per-gate). */
  ranSteps: ChainStepRecord[];
  /** The gate the chain halted at (auto_fix / require_human / deny). Absent when
   *  the whole chain completed. */
  atGate?: string;
  /** The output of the last allow, carried forward / returned on completion. */
  finalOutput?: unknown;
}

/**
 * Run the chain from the top until it advances past the last gate (completed) or
 * a gate halts it. Idempotent to re-invoke: after an auto_fix + the caller's
 * async re-run, calling runChain again re-evaluates from the start and converges.
 */
export async function runChain(
  steps: readonly ChainStep[],
  ctx: GateContext,
  opts: {
    /** Seed for the first step's input(). */
    startInput?: unknown;
    /** Called after each gate runs, with its full result - so a caller can audit
     *  every decision in the chain (each is a real gate decision, ledger-worthy). */
    onStep?: (gate: string, result: Awaited<ReturnType<typeof runGate>>) => void | Promise<void>;
  } = {},
): Promise<ChainRunResult> {
  const ran: ChainStepRecord[] = [];
  let carry = opts.startInput;

  for (const step of steps) {
    const result = await runGate(step.gate, step.input(carry), ctx);
    if (opts.onStep) await opts.onStep(step.gate.name, result);
    ran.push({ gate: step.gate.name, verdict: result.verdict, reason: result.reason });

    switch (result.verdict) {
      case "allow":
        carry = result.output ?? carry;
        continue;
      case "auto_fix":
        return { status: "fixing", ranSteps: ran, atGate: step.gate.name };
      case "require_human":
        return { status: "awaiting_human", ranSteps: ran, atGate: step.gate.name };
      case "deny":
        return { status: "denied", ranSteps: ran, atGate: step.gate.name };
    }
  }
  return { status: "completed", ranSteps: ran, finalOutput: carry };
}
