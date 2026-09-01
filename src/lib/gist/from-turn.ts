/**
 * An assistant turn, expressed as an ordinary decision.
 *
 * WHY THIS MAPPING IS THE PROOF. A universal shape nobody has mapped anything
 * into is a guess. This maps the ONE source that exists today, so the shape is
 * tested against real data before a second source is built to fit it, and any
 * awkwardness shows up now rather than after a connector is written.
 *
 * It also surfaces the honest weakness of our own data. Most turns map to
 * ending "unknown", because 93 per cent of conversations are a single question
 * and that means either satisfied or gave up. A change request from a forms
 * system will map to accepted, rejected or reversed, because somebody
 * explicitly decided. That gap is the argument for connecting one.
 */

import type { TurnGist } from "./features";
import type { DecisionGist, DecisionEnding } from "./decision";
import { endedWell } from "./decision";

/**
 * How a turn ended, in the universal vocabulary.
 *
 * The mapping is deliberately conservative: anything ambiguous becomes
 * "unknown" rather than being guessed into a category that would make the
 * numbers look better.
 */
function endingOf(g: TurnGist): DecisionEnding {
  switch (g.outcome) {
    /* The reader was told something was broken. Nobody got what they came
       for, and unlike a dead end it was not their corpus's fault. */
    case "degraded":
      return "abandoned";
    /* Told we had nothing and never returned. */
    case "dead_end":
      return "abandoned";
    /* Had to ask the same thing again: the first answer was undone by the
       person, which is the closest our data comes to a reversal. */
    case "re_asked":
      return "reversed";
    /* Asked which document was meant. Nothing was decided yet. */
    case "asked_which":
      return "pending";
    /* Pushed past a miss, or carried on: the exchange kept going, which is
       the strongest positive signal our own data offers. */
    case "pushed_past":
    case "continued":
      return "accepted";
    /* THE HONEST ONE. One question and no more means satisfied or gave up,
       and nothing here can tell which. Calling it either would be inventing
       the most common data point in the set. */
    case "single_turn":
      return "unknown";
    default:
      return "unknown";
  }
}

/** Which part of the product decided, in the universal vocabulary. */
function deciderOf(g: TurnGist): DecisionGist["decider"] {
  /* A model wrote it. */
  if (g.origin === "ai") return "automated";
  /* Retrieval and tools answer deterministically from a system of record;
     a person's question chose the path but no person chose the answer. */
  return "automated";
}

export function decisionFromTurn(g: TurnGist): DecisionGist {
  const ending = endingOf(g);
  return {
    domain: "assistant_answer",
    /* The question's shape is the closest thing a turn has to a category,
       and it is already a closed vocabulary. */
    category: g.shape,
    decider: deciderOf(g),
    /* Turn latency is not stored per message today, so this claims nothing
       rather than inventing a band. Recorded as a known gap: it is the one
       field this mapping cannot fill, and a forms system will fill it easily. */
    latency: "instant",
    ending,
    wentWell: endedWell("assistant_answer", ending),
  };
}
