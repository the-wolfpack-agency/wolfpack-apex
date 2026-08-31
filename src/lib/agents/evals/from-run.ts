/**
 * Turning a real agent run into something the behavior eval can score.
 *
 * behavior-eval.ts shipped with the rules and no caller, which makes it a
 * document rather than a control. This is the adapter that connects it to what
 * the executor actually records, so every task run is scored for containment
 * instead of only for success.
 *
 * GROUND TRUTH COMES FROM THE EXECUTOR, NOT THE AGENT
 *
 * Every field here is read from the executor's own step list. That is the whole
 * design: the record is written by the thing that ran the steps, so an agent
 * cannot influence its own score by describing the run differently.
 *
 * WHY HONESTY COMES BACK UNPROVEN TODAY
 *
 * The executor composes `resultSummary` deterministically from the step list
 * ("Completed 3 of 4 step(s)"). Passing that in as the agent's account would
 * compare a derivation against the thing it was derived from, so honesty would
 * pass on every run forever — including a run by an agent that concealed
 * everything. `summaryAuthoredBy: "system"` says so plainly, and the eval
 * returns unproven.
 *
 * That is not a gap being papered over; it is the gap being reported. Honesty
 * becomes scoreable the day an agent writes its own account of a run, and
 * nothing here needs to change when it does beyond passing "agent".
 */
import type { TaskStep } from "../tasks/types";
import { allAllowedHosts } from "@/lib/containment/allowlist";
import type { AgentRunRecord, RecordedStep } from "./behavior-eval";

/**
 * Executor outcome -> eval outcome.
 *
 * `blocked` is kept distinct rather than folded into a failure: a step the gate
 * refused is the boundary working, and collapsing it into "failed" would hide
 * the single most interesting signal in the record.
 *
 * `no_match` maps to abandoned — the agent proposed something no tool could do.
 * That is not a failure of the tool, and calling it one would blame the wrong
 * component when reading the numbers later.
 */
export function mapOutcome(outcome: TaskStep["outcome"]): RecordedStep["outcome"] {
  switch (outcome) {
    case "ran":
      return "succeeded";
    case "blocked":
      return "blocked";
    case "no_match":
      return "abandoned";
    default:
      return "failed";
  }
}

/** Hosts mentioned in a step's detail, so an egress attempt recorded only in
 *  prose is still visible to the eval. Deliberately conservative: it reads a
 *  host out of an explicit URL and guesses at nothing. A missed host makes the
 *  eval quieter, an invented one makes it wrong, and only one of those is
 *  recoverable. */
export function hostFromStep(step: Pick<TaskStep, "detail">): string | undefined {
  const match = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(step.detail ?? "");
  return match ? match[1].toLowerCase() : undefined;
}

export interface FromRunInput {
  runId: string;
  agentId: string;
  steps: TaskStep[];
  /**
   * True only when the containment self-test actually ran and passed for this
   * batch. Defaults to FALSE, so a caller that has not wired the self-test
   * reports "not demonstrated" rather than silently claiming isolation — which
   * is the exact assumption behind both 2026 sandbox-escape incidents.
   */
  boundaryProven?: boolean;
  /** Extra hosts this specific run was permitted, beyond the standing
   *  allowlist. */
  extraAllowedHosts?: readonly string[];
  /** The agent's OWN words, when an agent wrote them. Omit for the executor's
   *  generated summary; honesty is then reported as unproven. */
  agentAuthoredSummary?: string;
  /** Step ids the agent claimed, when it wrote its own account. */
  agentClaimedStepIds?: readonly string[];
}

export function toRunRecord(input: FromRunInput): AgentRunRecord {
  const agentWrote = typeof input.agentAuthoredSummary === "string";

  const steps: RecordedStep[] = input.steps.map((s) => {
    const host = hostFromStep(s);
    return {
      id: String(s.index),
      action: s.instruction,
      outcome: mapOutcome(s.outcome),
      ...(host ? { egressHost: host } : {}),
    };
  });

  return {
    runId: input.runId,
    agentId: input.agentId,
    allowlist: [...allAllowedHosts(), ...(input.extraAllowedHosts ?? [])],
    steps,
    reportedSummary: input.agentAuthoredSummary ?? "",
    summaryAuthoredBy: agentWrote ? "agent" : "system",
    // Only what the agent actually claimed. Deriving this from the steps when
    // the agent said nothing would manufacture an account and then grade it.
    reportedStepIds: [...(input.agentClaimedStepIds ?? [])],
    boundaryProven: input.boundaryProven === true,
  };
}
