/**
 * The product declares what kind of answer it gave; the gist reads it.
 *
 * WHAT THIS REPLACES. The gist worked the kind out by matching the answer's
 * PROSE, which is fragile in the way only prose is, and it cost real accuracy.
 * Measured 2026-08-30:
 *
 *   - 14 outage answers read as neutral, so somebody who suffered an outage
 *     was scored as satisfied
 *   - 187 model-written refusals matched no pattern at all, because the model
 *     phrases "I do not know" differently every time
 *
 * The product knew all of it at the moment it answered and threw it away.
 *
 * THE PATTERNS STAY, as the reader for messages written before the field
 * existed. Ninety days of history has no outcome_kind, and it is worth
 * reading. They are the legacy path now, not the primary one, and this pins
 * that ordering: a declared kind always wins, including when it disagrees.
 */

import { gistsFrom } from "@/lib/gist/extract";

function turn(over: Partial<Record<string, unknown>> = {}) {
  return [
    {
      conversation_id: "c1",
      role: "user",
      content: "what are the payment terms",
      source: null,
      created_at: "2026-08-30T12:00:00Z",
      outcome_kind: null,
    },
    {
      conversation_id: "c1",
      role: "assistant",
      content: "some answer",
      source: "ai",
      created_at: "2026-08-30T12:00:30Z",
      outcome_kind: null,
      ...over,
    },
  ];
}

describe("a declared outcome is believed", () => {
  it.each([
    ["degraded", "degraded"],
    ["asked_which", "asked_which"],
  ])("maps outcome_kind=%s to %s", (kind, expected) => {
    expect(gistsFrom(turn({ outcome_kind: kind }))[0].outcome).toBe(expected);
  });

  it("maps nothing_found to a dead end when nobody came back", () => {
    expect(gistsFrom(turn({ outcome_kind: "nothing_found" }))[0].outcome).toBe("dead_end");
  });

  /* THE CASE THE PATTERNS COULD NOT SEE. A model refusal phrased in its own
     words, declared by the product. No pattern is involved. */
  it("counts a model-written refusal it could never have matched", () => {
    const g = gistsFrom(
      turn({
        outcome_kind: "nothing_found",
        content: "Regrettably that particular detail eludes the material at hand.",
      }),
    )[0];
    expect(g.outcome).toBe("dead_end");
    expect(g.admittedMiss).toBe(true);
  });

  /* THE ORDERING, PINNED. If prose and declaration disagree, the declaration
     wins: it was recorded where the decision was made, and the prose is a
     guess made afterwards. */
  it("believes the declaration over the wording when they disagree", () => {
    const g = gistsFrom(
      turn({
        outcome_kind: "answered",
        content: 'No results found for "anything".',
      }),
    )[0];
    expect(g.admittedMiss).toBe(false);
    expect(g.outcome).not.toBe("dead_end");
  });
});

describe("history without the field still reads", () => {
  it("falls back to the prose when nothing was declared", () => {
    const g = gistsFrom(turn({ outcome_kind: null, content: 'No results found for "x".' }))[0];
    expect(g.admittedMiss).toBe(true);
    expect(g.outcome).toBe("dead_end");
  });

  it("still recognises an outage in old messages", () => {
    const g = gistsFrom(
      turn({
        outcome_kind: null,
        content: "I could not reach the search index just now, so I only looked at part of what you have.",
      }),
    )[0];
    expect(g.outcome).toBe("degraded");
  });
});
