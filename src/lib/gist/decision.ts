/**
 * A decision, in a shape that is the same whoever made it.
 *
 * WHY THIS EXISTS NOW. The gist works, on one source: the assistant's own
 * turns. The next sources are already named. Change requests live in Cognito
 * Forms, and CRM and DMS arrive in later phases. Each has decisions with
 * outcomes attached, and each will arrive with its own vocabulary.
 *
 * Deciding the common shape BEFORE the second source lands is the difference
 * between adding a connector and rewriting the measurement. It is also cheap
 * to get right now and expensive later, because by then there is a graph full
 * of records in the first source's shape.
 *
 * WHAT IS ACTUALLY COMMON. Strip an assistant answer and a change request down
 * and the same five things survive: somebody wanted something, something
 * decided, it took a while, it ended a particular way, and the ending was
 * either good or not. Nothing else generalises, and anything else added here
 * would be one source's detail wearing a universal name.
 *
 * SAFE BY CONSTRUCTION, WHICH IS THE WHOLE POINT. Every field is a closed
 * vocabulary or a bucketed number, exactly as TurnGist is. There is no free
 * text, so there is nothing to redact. That is what allows a decision made in
 * a client's system to teach ours without their data moving: what a change
 * request was ABOUT belongs to them, that a request of this shape took this
 * long and was reversed does not.
 *
 * A CHANGE REQUEST IS A BETTER INPUT THAN AN ASSISTANT TURN, and it is worth
 * saying why. Our own outcomes are derived and often ambiguous: 93 per cent of
 * conversations are a single turn that means either satisfied or gave up. A
 * change request carries its outcome explicitly, because somebody approved it,
 * rejected it, or reversed it later. Outcome labels are the scarce input for
 * everything the gist wants to do, and this is a source that has them.
 */

/** Which system the decision came from. Extended when a source is connected. */
export type DecisionDomain =
  /** An answer this product gave somebody. */
  | "assistant_answer"
  /** A change request, approval or process step in a forms system. */
  | "change_request"
  /** A record written or updated in a CRM. */
  | "crm_record"
  /** Anything from a source connected before this list caught up. */
  | "other";

/** Who or what decided. The single most useful axis across every source. */
export type DeciderKind =
  /** No person in the loop. */
  | "automated"
  /** A person chose. */
  | "human"
  /** Proposed by a machine, confirmed by a person, which is the gate's shape. */
  | "mixed";

/** How long it took, bucketed because an exact duration is a fingerprint. */
export type LatencyBand = "instant" | "seconds" | "minutes" | "hours" | "days" | "longer";

/**
 * How it ended.
 *
 * Deliberately smaller than any one source's status list. Cognito Forms will
 * have a dozen statuses and a CRM another dozen; mapping them into six is the
 * work that makes them comparable, and keeping a source's own words here would
 * defeat the purpose.
 */
export type DecisionEnding =
  /** Went ahead: an answer was used, a request approved. */
  | "accepted"
  /** Refused on purpose, which is a good outcome when it is the right call. */
  | "rejected"
  /** Went ahead and was undone later. The most informative ending there is. */
  | "reversed"
  /** Nobody finished it. */
  | "abandoned"
  /** Still open at the time of reading. */
  | "pending"
  /** Ended, and the source cannot say how. */
  | "unknown";

export interface DecisionGist {
  domain: DecisionDomain;
  /**
   * The kind of decision within its domain, from a vocabulary the SOURCE
   * declares. Never free text: an unmapped category becomes "other" rather
   * than carrying the source's own wording through.
   */
  category: string;
  decider: DeciderKind;
  latency: LatencyBand;
  ending: DecisionEnding;
  /**
   * Whether this ending was a good one, decided per domain rather than
   * globally. A rejected change request is often the system working; an
   * abandoned answer never is.
   */
  wentWell: boolean;
}

export const DECISION_VOCABULARY = {
  domain: ["assistant_answer", "change_request", "crm_record", "other"] as DecisionDomain[],
  decider: ["automated", "human", "mixed"] as DeciderKind[],
  latency: ["instant", "seconds", "minutes", "hours", "days", "longer"] as LatencyBand[],
  ending: ["accepted", "rejected", "reversed", "abandoned", "pending", "unknown"] as DecisionEnding[],
} as const;

export function latencyBand(ms: number): LatencyBand {
  if (!Number.isFinite(ms) || ms < 0) return "instant";
  if (ms < 1_000) return "instant";
  if (ms < 60_000) return "seconds";
  if (ms < 3_600_000) return "minutes";
  if (ms < 86_400_000) return "hours";
  if (ms < 7 * 86_400_000) return "days";
  return "longer";
}

/**
 * Whether an ending counts as having gone well, per domain.
 *
 * REJECTION IS NOT FAILURE EVERYWHERE, and getting this wrong would teach the
 * worst possible lesson. A change request refused by a reviewer is the process
 * working: a system that learned to approve everything in order to score well
 * would be actively dangerous. An assistant answer nobody accepted is a
 * different thing entirely.
 *
 * REVERSAL IS ALWAYS BAD, and it is the most informative signal any of these
 * sources carry: somebody decided, acted, and had to undo it. Nothing in our
 * own data is that clear, which is the argument for connecting a source that
 * has it.
 */
export function endedWell(domain: DecisionDomain, ending: DecisionEnding): boolean {
  if (ending === "reversed" || ending === "abandoned") return false;
  if (ending === "pending" || ending === "unknown") return false;
  if (ending === "accepted") return true;
  /* rejected */
  return domain === "change_request";
}
