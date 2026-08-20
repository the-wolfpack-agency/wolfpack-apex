/**
 * What happens when a workspace approaches its AI spend limit.
 *
 * THE INDUSTRY ANSWER, AND WHY IT IS THE WRONG SHAPE
 *
 * OpenRouter's budget guardrail sets a cap per key and fails requests that
 * exceed it with a 402. Router.com's pitch is cost reduction and does not
 * mention limits at all. A hard cap is easy to implement and easy to sell, and
 * it has one failure mode that matters: the person on the other end is in the
 * middle of something. The cap does not arrive when the finance team is
 * looking; it arrives at 4pm on a Thursday while somebody is drafting a reply
 * to a client, and the product simply stops.
 *
 * The result is predictable. Caps get set high enough never to fire, which
 * means they do not control spend, or they fire and somebody raises them in a
 * hurry, which means the same. A control that people route around is not a
 * control.
 *
 * WHAT WE DO INSTEAD: A GOVERNOR, NOT A WALL
 *
 * Spend is bounded by DEGRADING capability before refusing service. As a
 * workspace approaches its limit, questions keep being answered, by cheaper
 * models. The person keeps working, the bill stops climbing at the same rate,
 * and somebody has time to decide whether the limit was right.
 *
 *   under the warn line   nothing changes
 *   warn line to the cap  clamp to the cheapest tier that can still answer
 *   over the cap          cheapest tier only, and say so
 *   over the hard ceiling stop, because at some point spending must stop
 *
 * The ceiling exists so this is a real control and not a suggestion: a runaway
 * loop still gets stopped. It is deliberately well above the cap, because the
 * cap is a budget and the ceiling is an incident.
 *
 * DEGRADING IS NOT FREE, AND WE SAY SO. A cheaper model gives a worse answer to
 * a hard question. That is a trade the reader is entitled to know about, so
 * every governed turn records why it was governed, and the assistant can tell
 * them. Silently serving worse answers to save money would be the same dishonesty
 * as the estimate that read $0.00.
 *
 * Pure and deterministic: no clock, no database, no network. The caller
 * supplies what was spent; this decides what to do about it.
 */
import type { AIModelTier } from "./types";

/** Fraction of the cap at which capability starts being clamped. */
export const WARN_FRACTION = 0.8;
/**
 * Multiple of the cap at which requests stop entirely.
 *
 * Not 1.0. Between the cap and the ceiling the product still works, at the
 * cheapest tier, which is the whole point of a governor. A workspace that
 * crosses the ceiling is not overspending, it is malfunctioning.
 */
export const CEILING_MULTIPLE = 2;

export type BudgetState = "ok" | "approaching" | "over" | "stopped";

export interface BudgetDecision {
  state: BudgetState;
  /** The tier to actually use. Never higher than what was requested. */
  tier: AIModelTier;
  /** True when the request must not be sent at all. */
  stop: boolean;
  /** Why, in a token an operator can group by. */
  reason: "within_budget" | "approaching_cap" | "over_cap" | "hard_ceiling" | "no_cap";
  /** What to tell the person, when there is something worth telling them.
   *  Null when nothing changed, because a note on every turn is noise. */
  notice: string | null;
  /** 0 to 1+, for a progress bar. Null when there is no cap. */
  fraction: number | null;
}

const TIER_ORDER: AIModelTier[] = ["cheap", "standard", "premium"];

/** Never raise a tier: a budget may restrict and may not escalate. */
function clampDown(requested: AIModelTier, ceiling: AIModelTier): AIModelTier {
  return TIER_ORDER.indexOf(requested) <= TIER_ORDER.indexOf(ceiling) ? requested : ceiling;
}

export function governTier(input: {
  /** Measured spend in the current window, in USD. */
  spentUsd: number;
  /** The workspace's cap, or null when it has none. */
  capUsd: number | null;
  requestedTier: AIModelTier;
}): BudgetDecision {
  const { spentUsd, capUsd, requestedTier } = input;

  /* No cap is not the same as an unlimited cap: there is nothing to report,
     nothing to degrade, and no fraction to draw. */
  if (capUsd === null || !Number.isFinite(capUsd) || capUsd <= 0) {
    return { state: "ok", tier: requestedTier, stop: false, reason: "no_cap", notice: null, fraction: null };
  }

  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  const fraction = spent / capUsd;

  if (fraction >= CEILING_MULTIPLE) {
    return {
      state: "stopped",
      tier: "cheap",
      stop: true,
      reason: "hard_ceiling",
      notice: `AI is paused for this workspace: spending reached ${CEILING_MULTIPLE} times the limit. Raise the limit or wait for the next period.`,
      fraction,
    };
  }

  if (fraction >= 1) {
    return {
      state: "over",
      tier: "cheap",
      stop: false,
      reason: "over_cap",
      notice: "This workspace is over its AI limit, so answers are coming from the smallest model. They will be shorter and less thorough until the limit is raised or the period resets.",
      fraction,
    };
  }

  if (fraction >= WARN_FRACTION) {
    const tier = clampDown(requestedTier, "standard");
    return {
      state: "approaching",
      tier,
      stop: false,
      reason: "approaching_cap",
      /* Only worth saying when something actually changed. Somebody asking a
         simple question at 85% of the cap has lost nothing. */
      notice:
        tier === requestedTier
          ? null
          : "This workspace is near its AI limit, so this answer used a smaller model than usual.",
      fraction,
    };
  }

  return { state: "ok", tier: requestedTier, stop: false, reason: "within_budget", notice: null, fraction };
}
