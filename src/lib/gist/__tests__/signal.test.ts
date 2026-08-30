/**
 * The measurement that decides whether the graph is worth building.
 *
 * MEASURED ON 90 DAYS OF PRODUCTION, 2026-08-30, after removing one circular
 * feature (see below):
 *
 *     12,037 answered turns, base rate of a bad ending 3.5%
 *     origin=ai            n=  247   bad 39.3%   lift 11.25
 *     shape=content        n=  112   bad 23.2%   lift  6.65
 *     shape=existence      n=   37   bad 13.5%   lift  3.87
 *     answerLength=short   n=4,635   bad  6.4%   lift  1.83
 *     shape=action         n=1,380   bad  0.0%   lift  0.00
 *     origin=knowledge_cache n=2,840 bad  0.0%   lift  0.00
 *
 * A record containing no private data predicts an eleven-fold difference in
 * whether somebody walks away. That is the finding the proposal needed.
 */

import { measureSignal, endedBadly, MIN_OBSERVATIONS, EXCLUDED_AS_CIRCULAR } from "@/lib/gist/signal";
import type { TurnGist } from "@/lib/gist/features";

function gist(over: Partial<TurnGist> = {}): TurnGist {
  return {
    shape: "other",
    origin: "tool",
    answerLength: "medium",
    questionLength: "short",
    hadSources: false,
    admittedMiss: false,
    outcome: "continued",
    ...over,
  };
}

describe("what counts as a bad ending", () => {
  it("counts a dead end and a re-ask", () => {
    expect(endedBadly(gist({ outcome: "dead_end" }))).toBe(true);
    expect(endedBadly(gist({ outcome: "re_asked" }))).toBe(true);
  });

  /* THE JUDGEMENT CALL, ASSERTED. 94.8% of turns are single_turn. Calling it
     bad puts the base rate at 95% and makes every lift meaningless; calling it
     good is the flattering half of an ambiguity nothing can resolve. It stays
     in the population and out of the label. */
  it("does not count a single-turn conversation either way", () => {
    expect(endedBadly(gist({ outcome: "single_turn" }))).toBe(false);
  });

  it("does not count somebody who pushed past a miss", () => {
    expect(endedBadly(gist({ outcome: "pushed_past" }))).toBe(false);
  });
});

describe("finding signal", () => {
  it("reports lift against the base rate", () => {
    const gists = [
      ...Array.from({ length: 90 }, () => gist({ origin: "tool", outcome: "continued" })),
      ...Array.from({ length: 10 }, () => gist({ origin: "tool", outcome: "dead_end" })),
      ...Array.from({ length: 50 }, () => gist({ origin: "ai", outcome: "dead_end" })),
    ];
    const r = measureSignal(gists);
    const ai = r.signals.find((s) => s.feature === "origin" && s.value === "ai")!;
    expect(ai.badRate).toBe(1);
    expect(ai.lift).toBeGreaterThan(2);
    expect(ai.trustworthy).toBe(true);
  });

  /* THE RULE THAT STOPS A FINDING FROM BEING NOISE. This codebase adopted a
     conclusion from six data points once and had to reverse it. */
  it("refuses to trust a value with too few observations", () => {
    const gists = [
      ...Array.from({ length: 200 }, () => gist({ outcome: "continued" })),
      ...Array.from({ length: 3 }, () => gist({ origin: "fallback", outcome: "dead_end" })),
    ];
    const r = measureSignal(gists);
    const rare = r.signals.find((s) => s.value === "fallback")!;
    expect(rare.observations).toBeLessThan(MIN_OBSERVATIONS);
    expect(rare.trustworthy).toBe(false);
    expect(r.usable).not.toContain(rare);
  });

  /* A feature that shifts the rate slightly is real and changes nothing
     anybody would do, so it must not be reported as actionable. */
  it("ignores a real but tiny difference", () => {
    const gists = [
      ...Array.from({ length: 100 }, (_, i) => gist({ origin: "tool", outcome: i < 10 ? "dead_end" : "continued" })),
      ...Array.from({ length: 100 }, (_, i) => gist({ origin: "brain", outcome: i < 11 ? "dead_end" : "continued" })),
    ];
    expect(measureSignal(gists).usable).toEqual([]);
  });

  it("says nothing at all rather than dividing by zero on a clean window", () => {
    const r = measureSignal(Array.from({ length: 50 }, () => gist({ outcome: "continued" })));
    expect(r.baseBadRate).toBe(0);
    expect(r.signals.every((s) => s.lift === 0)).toBe(true);
  });

  it("handles an empty window", () => {
    expect(measureSignal([])).toMatchObject({ turns: 0, usable: [] });
  });

  /* THE MISTAKE THE FIRST RUN MADE, PINNED. admittedMiss scored a lift of 27.9
     and looked like the strongest finding on the board. It was circular: a
     dead_end is DEFINED as a miss nobody followed up, so it was predicting
     itself. A field that participates in the outcome must never be a
     predictor. */
  it("keeps the circular feature out of the predictors", () => {
    const r = measureSignal([gist({ admittedMiss: true, outcome: "dead_end" })]);
    expect(r.signals.some((s) => s.feature === "admittedMiss")).toBe(false);
    expect(EXCLUDED_AS_CIRCULAR).toContain("admittedMiss");
  });
});

/**
 * HONESTY IS NOT AUTOMATICALLY A SUCCESS.
 *
 * asked_which and degraded are both the product telling the truth, and that is
 * where the resemblance stops. Asking which document is the RIGHT answer to a
 * vague question. An outage is the product failing somebody who asked a
 * perfectly good one.
 *
 * The distinction matters because the gist is meant to teach: scoring them the
 * same way would tell it either that outages are fine or that asking is a
 * failure, and both would push the product in the wrong direction.
 */
describe("the two honest outcomes are scored differently", () => {
  it("does not count asking which document as a bad ending", () => {
    expect(endedBadly(gist({ outcome: "asked_which" }))).toBe(false);
  });

  it("counts an outage as a bad ending", () => {
    expect(endedBadly(gist({ outcome: "degraded" }))).toBe(true);
  });
});
