/**
 * The gist must be incapable of carrying private data, not merely scrubbed of it.
 *
 * THE WHOLE PROPOSITION RESTS ON THIS. The argument for learning across client
 * engagements is that decision SHAPE is separable from decision CONTENT: what
 * somebody asked about belongs to them, how the machine behaved does not. That
 * is only true if the gist has no field capable of holding a subject.
 *
 * So this does not check that names were removed. It checks that every value a
 * gist can hold comes from a vocabulary declared in advance, which means there
 * is nothing to remove. A redaction pass can miss something; a closed set
 * cannot.
 *
 * THE RE-IDENTIFICATION LINE. "Asked about a named incentive tier in a small
 * market" is a shape AND a fingerprint. The defence is structural: no field
 * here names a topic, a document, a person, a place or a time. What survives
 * is how the product behaved.
 */

import { VOCABULARY, lengthBand, answerOrigin, questionShape } from "@/lib/gist/features";
import { gistsFrom } from "@/lib/gist/extract";

/* A conversation carrying exactly the things that must not survive. */
const SENSITIVE_ROWS = [
  {
    conversation_id: "c1",
    role: "user",
    content: "what does the Porsche Monmouth SOW say about Hector Hernandez's commission?",
    source: null,
    created_at: "2026-08-30T12:00:00Z",
  },
  {
    conversation_id: "c1",
    role: "assistant",
    content:
      "Hector Hernandez is paid 4% on units. Card on file 4111 1111 1111 1111, contact hector@example-dealer.com.",
    source: "brain",
    created_at: "2026-08-30T12:00:30Z",
  },
];

describe("a gist cannot carry what a person said", () => {
  const gists = gistsFrom(SENSITIVE_ROWS);

  it("produces a gist from a conversation full of identifiers", () => {
    expect(gists).toHaveLength(1);
  });

  /* THE ASSERTION THE PROPOSAL DEPENDS ON. */
  it.each([
    ["a surname", "Hernandez"],
    ["a first name", "Hector"],
    ["a client site", "Monmouth"],
    ["a brand", "Porsche"],
    ["a document name", "SOW"],
    ["an email domain", "example-dealer.com"],
    ["a card number", "4111"],
    ["a commission rate", "4%"],
  ])("does not carry %s", (_label, needle) => {
    expect(JSON.stringify(gists)).not.toContain(needle);
  });

  it("holds only values from a declared vocabulary", () => {
    for (const g of gists) {
      expect(VOCABULARY.shape).toContain(g.shape);
      expect(VOCABULARY.origin).toContain(g.origin);
      expect(VOCABULARY.band).toContain(g.answerLength);
      expect(VOCABULARY.band).toContain(g.questionLength);
      expect(VOCABULARY.outcome).toContain(g.outcome);
      expect(typeof g.hadSources).toBe("boolean");
      expect(typeof g.admittedMiss).toBe("boolean");
    }
  });

  /* Fails loudly if somebody later adds a string field that is not a closed
     set, which is the only way private data could get back in. */
  it("has no field holding arbitrary text", () => {
    const declared = new Set<string>([
      ...VOCABULARY.shape,
      ...VOCABULARY.origin,
      ...VOCABULARY.band,
      ...VOCABULARY.outcome,
    ]);
    for (const g of gists) {
      for (const [key, value] of Object.entries(g)) {
        if (typeof value !== "string") continue;
        expect(`${key}: ${declared.has(value) ? "declared" : `UNDECLARED (${value})`}`).toBe(
          `${key}: declared`,
        );
      }
    }
  });
});

describe("the reductions themselves", () => {
  it("buckets length rather than keeping it, because an exact length fingerprints", () => {
    expect(lengthBand("")).toBe("none");
    expect(lengthBand("short answer")).toBe("short");
    expect(lengthBand("x".repeat(400))).toBe("medium");
    expect(lengthBand("x".repeat(2000))).toBe("long");
  });

  /* A new source added elsewhere in the product must not silently widen the
     gist's vocabulary. */
  it("maps an unrecognised source into the vocabulary", () => {
    expect(answerOrigin("brain")).toBe("brain");
    expect(answerOrigin("some_new_source_nobody_declared")).toBe("other");
    expect(answerOrigin(null)).toBe("other");
  });

  it("classifies shape without keeping the sentence", () => {
    const deps = { isContentQuestion: () => true, isExistenceQuestion: () => false };
    expect(questionShape("what does the SOW say", deps)).toBe("content");
    expect(questionShape("send an email to the team", deps)).toBe("action");
    expect(questionShape("", deps)).toBe("other");
  });
});
