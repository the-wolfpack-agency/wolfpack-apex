/**
 * One decision shape, whoever made it.
 *
 * WHY IT WAS DEFINED BEFORE THE SECOND SOURCE. The gist works on one source,
 * the assistant's own turns. The next are already named: change requests in
 * Cognito Forms, then CRM and DMS. Deciding the common shape before the second
 * one lands is the difference between adding a connector and rewriting the
 * measurement, and it is cheap now and expensive once a graph is full of
 * records in the first source's shape.
 *
 * MEASURED ON REAL DATA, 2026-08-30. Mapping 11,997 assistant turns:
 *
 *   unknown    11,154   93.0%
 *   abandoned     590    4.9%
 *   accepted      203    1.7%
 *   reversed       32    0.3%
 *   pending        18    0.2%
 *
 * Seven per cent of our own decisions have an ending we can name. That is the
 * argument for connecting a source that states its outcome: a change request
 * is approved, rejected or reversed because somebody decided, not because we
 * inferred it from whether they came back.
 */

import {
  DECISION_VOCABULARY,
  endedWell,
  latencyBand,
  type DecisionDomain,
  type DecisionEnding,
} from "@/lib/gist/decision";
import { decisionFromTurn } from "@/lib/gist/from-turn";
import type { TurnGist } from "@/lib/gist/features";

function turn(over: Partial<TurnGist> = {}): TurnGist {
  return {
    shape: "content",
    origin: "brain",
    answerLength: "medium",
    questionLength: "short",
    hadSources: true,
    admittedMiss: false,
    outcome: "continued",
    ...over,
  };
}

describe("what counts as having gone well, per domain", () => {
  /* REJECTION IS NOT FAILURE EVERYWHERE, and getting this wrong would teach
     the worst possible lesson. A change request refused by a reviewer is the
     process working. A system that learned to approve everything in order to
     score well would be actively dangerous. */
  it("counts a rejected change request as a good outcome", () => {
    expect(endedWell("change_request", "rejected")).toBe(true);
  });

  it("does not count a rejected assistant answer as a good outcome", () => {
    expect(endedWell("assistant_answer", "rejected")).toBe(false);
  });

  /* REVERSAL IS ALWAYS BAD, and it is the most informative signal any source
     carries: somebody decided, acted, and had to undo it. */
  it.each(["assistant_answer", "change_request", "crm_record", "other"] as DecisionDomain[])(
    "counts a reversal as bad in %s",
    (domain) => {
      expect(endedWell(domain, "reversed")).toBe(false);
    },
  );

  it.each(["pending", "unknown"] as DecisionEnding[])(
    "does not credit %s as a good outcome",
    (ending) => {
      expect(endedWell("change_request", ending)).toBe(false);
    },
  );

  it("counts an accepted decision as good in every domain", () => {
    for (const d of DECISION_VOCABULARY.domain) expect(endedWell(d, "accepted")).toBe(true);
  });
});

describe("latency is bucketed, never exact", () => {
  it.each([
    [0, "instant"],
    [500, "instant"],
    [5_000, "seconds"],
    [120_000, "minutes"],
    [7_200_000, "hours"],
    [172_800_000, "days"],
    [30 * 86_400_000, "longer"],
  ])("%sms is %s", (ms, band) => {
    expect(latencyBand(ms as number)).toBe(band);
  });

  it("does not throw on nonsense", () => {
    expect(latencyBand(NaN)).toBe("instant");
    expect(latencyBand(-1)).toBe("instant");
  });
});

describe("an assistant turn as an ordinary decision", () => {
  it.each([
    ["continued", "accepted"],
    ["pushed_past", "accepted"],
    ["dead_end", "abandoned"],
    ["degraded", "abandoned"],
    ["re_asked", "reversed"],
    ["asked_which", "pending"],
  ])("maps %s to %s", (outcome, ending) => {
    expect(decisionFromTurn(turn({ outcome: outcome as TurnGist["outcome"] })).ending).toBe(ending);
  });

  /* THE HONEST ONE, AND THE MOST COMMON. One question and no more means
     satisfied or gave up. Calling it either would be inventing 93 per cent of
     the data set. */
  it("refuses to guess a single-turn conversation", () => {
    expect(decisionFromTurn(turn({ outcome: "single_turn" })).ending).toBe("unknown");
    expect(decisionFromTurn(turn({ outcome: "single_turn" })).wentWell).toBe(false);
  });

  it("carries no free text into the universal shape", () => {
    const d = decisionFromTurn(turn());
    expect(DECISION_VOCABULARY.domain).toContain(d.domain);
    expect(DECISION_VOCABULARY.decider).toContain(d.decider);
    expect(DECISION_VOCABULARY.latency).toContain(d.latency);
    expect(DECISION_VOCABULARY.ending).toContain(d.ending);
    /* category comes from the turn's own closed vocabulary. */
    expect(["content", "existence", "action", "other"]).toContain(d.category);
  });

  /* A re-ask is the closest our data comes to a reversal, and reversals are
     the signal we most want. It must not be quietly scored as fine. */
  it("treats a re-ask as a bad outcome", () => {
    expect(decisionFromTurn(turn({ outcome: "re_asked" })).wentWell).toBe(false);
  });
});
