/**
 * Budget ceilings, and a stop that works.
 *
 * The vending-machine agent ran a simulated year unsupervised, and the only
 * oversight was a report that "may or may not be acted upon". The researchers'
 * conclusion was that frontier models are not ready to be trusted as
 * unsupervised long-running agents. Ours should not be able to be.
 *
 * Two controls, and they are different:
 *
 *   A BUDGET bounds one run. It is not a cost control — it is a blast-radius
 *   control. An agent that has spent its allowance pauses and raises an
 *   approval rather than continuing, so the worst case is bounded by a number
 *   someone chose rather than by how long it takes a person to notice.
 *
 *   A KILL SWITCH stops everything, now, and is checked before every step
 *   rather than at the start of a run. A switch that only takes effect on the
 *   next run is not a stop; it is a preference.
 *
 * Fails closed in both directions. If the ledger cannot be read we do not know
 * what has been spent, and an unknown spend is not a permitted one. If the
 * switch state cannot be read we assume stopped: the cost of a false stop is a
 * delayed run, and the cost of a false start is the thing the switch exists to
 * prevent.
 *
 * Pure. The caller supplies the numbers; this decides what they mean.
 */

export interface RunBudget {
  /** Model tokens, in + out. */
  maxTokens: number;
  /** Wall clock for the whole run. */
  maxDurationMs: number;
  /** Outbound calls, across every capability. */
  maxEgressCalls: number;
  /** Money, in the smallest unit, so there is no float in a limit. */
  maxSpendCents: number;
}

export interface RunSpend {
  tokens: number;
  durationMs: number;
  egressCalls: number;
  spendCents: number;
}

/** Sensible default for an unattended run. Deliberately small: a run that needs
 *  more should say so, and saying so is the review moment. */
export const DEFAULT_BUDGET: RunBudget = {
  maxTokens: 200_000,
  maxDurationMs: 10 * 60 * 1000,
  maxEgressCalls: 200,
  maxSpendCents: 500,
};

export type StepDecision =
  | { proceed: true; remaining: RunSpend }
  | { proceed: false; reason: string; breached: keyof RunBudget | "kill-switch" | "unreadable" };

export interface ContainmentState {
  /** False when the operator has stopped all agent work. */
  agentsEnabled: boolean;
  /** Null when the state could not be read. Distinct from false on purpose. */
  readable: boolean;
}

/**
 * May this run take another step?
 *
 * Checked BEFORE each step, not after: a step that would breach the budget must
 * not run and then be reported, because the thing we are bounding is what the
 * agent does, not what it admits to.
 */
export function decideStep(budget: RunBudget, spend: RunSpend, state: ContainmentState): StepDecision {
  if (!state.readable) {
    // Unknown switch state is treated as stopped. A delayed run is cheap; a run
    // that should have been stopped is the thing the switch exists for.
    return { proceed: false, reason: "the containment state could not be read, so the run is treated as stopped", breached: "unreadable" };
  }
  if (!state.agentsEnabled) {
    return { proceed: false, reason: "agent work is stopped for this workspace", breached: "kill-switch" };
  }

  const checks: { key: keyof RunBudget; used: number; limit: number; label: string }[] = [
    { key: "maxTokens", used: spend.tokens, limit: budget.maxTokens, label: "token" },
    { key: "maxDurationMs", used: spend.durationMs, limit: budget.maxDurationMs, label: "time" },
    { key: "maxEgressCalls", used: spend.egressCalls, limit: budget.maxEgressCalls, label: "outbound call" },
    { key: "maxSpendCents", used: spend.spendCents, limit: budget.maxSpendCents, label: "spend" },
  ];
  for (const c of checks) {
    if (!Number.isFinite(c.used)) {
      // An unreadable ledger is not a zero ledger.
      return { proceed: false, reason: `${c.label} usage could not be read, so the run is paused`, breached: "unreadable" };
    }
    if (c.used >= c.limit) {
      return { proceed: false, reason: `${c.label} budget exhausted (${c.used} of ${c.limit})`, breached: c.key };
    }
  }

  return {
    proceed: true,
    remaining: {
      tokens: budget.maxTokens - spend.tokens,
      durationMs: budget.maxDurationMs - spend.durationMs,
      egressCalls: budget.maxEgressCalls - spend.egressCalls,
      spendCents: budget.maxSpendCents - spend.spendCents,
    },
  };
}

/**
 * Merge an operator's override onto the default.
 *
 * A raise is allowed and recorded; it is a decision someone makes. A limit that
 * is absent, negative or not a number falls back to the default rather than to
 * "unlimited", because a typo must never become permission.
 */
export function resolveBudget(override: Partial<RunBudget> | null | undefined): RunBudget {
  const out = { ...DEFAULT_BUDGET };
  if (!override) return out;
  for (const key of Object.keys(DEFAULT_BUDGET) as (keyof RunBudget)[]) {
    const value = override[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = Math.floor(value);
  }
  return out;
}

/** How close a run is to each ceiling, 0 to 1, for the surface that shows it. */
export function budgetPressure(budget: RunBudget, spend: RunSpend): Record<keyof RunBudget, number> {
  const ratio = (used: number, limit: number) => (limit <= 0 ? 1 : Math.min(1, Math.max(0, used / limit)));
  return {
    maxTokens: ratio(spend.tokens, budget.maxTokens),
    maxDurationMs: ratio(spend.durationMs, budget.maxDurationMs),
    maxEgressCalls: ratio(spend.egressCalls, budget.maxEgressCalls),
    maxSpendCents: ratio(spend.spendCents, budget.maxSpendCents),
  };
}
