/**
 * An outage must not be reported as an empty library.
 *
 * MEASURED 2026-08-30 against the production database. A document containing
 * the answer is in the corpus. Make the model provider unreachable and ask for
 * the payment terms:
 *
 *   before  "I don't have information on that yet. You can help me learn by
 *            adding it to the Knowledge Base..."
 *   after   "I could not reach the search index just now... I could not reach
 *            the model that writes answers just now... Nothing has been lost,
 *            and nothing needs re-uploading..."
 *
 * The old sentence was false in every clause, and its last one invited a client
 * to upload a second copy of a document the product already held. In a
 * walkthrough it reads as the product having lost their documents.
 *
 * THE FAILURE CLASS, for the fourth time in this codebase: a store that can be
 * empty for two different reasons, and code that only knows one of them. Also
 * found in the triple write (unconfigured Neo4j read as healthy), in the
 * semantic half of the Brain (a bare catch hid a month of zero hits), and in
 * universal search (timedOut set, never read).
 */

import { degradedAnswer, TurnDegradation } from "@/lib/assistant/degraded-answer";

/** The exact suggestion that caused the damage. */
const RE_UPLOAD_INVITATION = /add(ing)? it to the Knowledge Base/i;

describe("a healthy turn gets no outage message", () => {
  /* THE HALF THAT IS EASY TO GET WRONG IN THE OTHER DIRECTION. "I have nothing
     on that" is a good answer when it is true, and dressing every empty result
     up as an outage would be this same defect pointed backwards. */
  it("returns null when nothing broke", () => {
    expect(degradedAnswer([])).toBeNull();
    expect(new TurnDegradation().answer()).toBeNull();
    expect(new TurnDegradation().any).toBe(false);
  });
});

describe("a degraded turn says what broke", () => {
  it("names the semantic store when only it failed", () => {
    const a = degradedAnswer([{ kind: "semantic_search" }])!;
    expect(a.text).toMatch(/search index/i);
    expect(a.kinds).toEqual(["semantic_search"]);
  });

  it("names the model when only it failed", () => {
    const a = degradedAnswer([{ kind: "model" }])!;
    expect(a.text).toMatch(/model that writes answers/i);
    expect(a.kinds).toEqual(["model"]);
  });

  it("names both when both failed, which is the common real outage", () => {
    /* The embedder and the chat model sit behind the same endpoint, so one
       unreachable host degrades both. Measured: kinds came back as exactly
       ["semantic_search","model"]. */
    const a = degradedAnswer([{ kind: "model" }, { kind: "semantic_search" }])!;
    expect(a.kinds).toEqual(["semantic_search", "model"]);
    expect(a.text).toMatch(/search index/i);
    expect(a.text).toMatch(/model that writes answers/i);
  });

  /* Two failures of one kind are one problem to a reader, and the wording must
     be identical every time the same thing breaks so somebody can recognise a
     repeat outage. */
  it("says a repeated failure once", () => {
    const twice = degradedAnswer([{ kind: "model" }, { kind: "model", detail: "429" }])!;
    expect(twice.kinds).toEqual(["model"]);
    expect(twice.text).toBe(degradedAnswer([{ kind: "model" }])!.text);
  });
});

/**
 * WHAT THE MESSAGE MUST AND MUST NOT CONTAIN. These are the properties that
 * make it safe to show a client, and each maps to something the old message
 * got wrong.
 */
describe("what a client is told", () => {
  const everyCombination = [
    [{ kind: "semantic_search" as const }],
    [{ kind: "model" as const }],
    [{ kind: "integration" as const }],
    [{ kind: "semantic_search" as const }, { kind: "model" as const }],
    [{ kind: "semantic_search" as const }, { kind: "model" as const }, { kind: "integration" as const }],
  ];

  it.each(everyCombination.map((d, i) => [i, d]))(
    "combination %i never invites a re-upload",
    (_i, degradations) => {
      expect(degradedAnswer(degradations)!.text).not.toMatch(RE_UPLOAD_INVITATION);
    },
  );

  it.each(everyCombination.map((d, i) => [i, d]))(
    "combination %i promises nothing was lost",
    (_i, degradations) => {
      const t = degradedAnswer(degradations)!.text;
      expect(t).toMatch(/nothing has been lost/i);
      expect(t).toMatch(/still there/i);
    },
  );

  it.each(everyCombination.map((d, i) => [i, d]))(
    "combination %i puts the fault on our side and says what to do",
    (_i, degradations) => {
      const t = degradedAnswer(degradations)!.text;
      expect(t).toMatch(/our side, not with your question/i);
      expect(t).toMatch(/try again/i);
    },
  );

  /* A reader does not need our vendor list, and naming one turns an outage
     message into an information disclosure. */
  it.each(everyCombination.map((d, i) => [i, d]))(
    "combination %i names no vendor or internal detail",
    (_i, degradations) => {
      const t = degradedAnswer(degradations)!.text;
      for (const leak of [/qdrant/i, /azure/i, /openai/i, /postgres/i, /neo4j/i, /anthropic/i, /http/i]) {
        expect(t).not.toMatch(leak);
      }
    },
  );

  /* The detail is for the event, not the reader. */
  it("never shows the raw error text", () => {
    const a = degradedAnswer([
      { kind: "model", detail: "connect ECONNREFUSED 127.0.0.1:9" },
    ])!;
    expect(a.text).not.toMatch(/ECONNREFUSED/);
    expect(a.text).not.toMatch(/127\.0\.0\.1/);
  });
});

describe("the per-turn collector", () => {
  /* Per-turn rather than module state: two people asking at the same moment
     must not inherit each other's outages. */
  it("keeps two turns independent", () => {
    const mine = new TurnDegradation();
    const theirs = new TurnDegradation();
    mine.record("model", "boom");
    expect(mine.any).toBe(true);
    expect(theirs.any).toBe(false);
    expect(theirs.answer()).toBeNull();
  });

  it("truncates a long detail rather than carrying it around", () => {
    const t = new TurnDegradation();
    t.record("model", "x".repeat(5000));
    expect(t.all[0].detail!.length).toBeLessThanOrEqual(200);
  });
});
