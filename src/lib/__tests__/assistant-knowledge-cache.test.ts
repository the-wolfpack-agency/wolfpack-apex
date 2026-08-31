/**
 * A model answer is not knowledge until a person says it is.
 *
 * Every past model answer is saved to instinct_knowledge with source='ai' and
 * no rating. The knowledge path kept unrated rows on the reasoning that they
 * are "fresh knowledge the team just added", and in production 190 of 215 rows
 * were AI-authored and unrated, so that was false for 88 per cent of the
 * table. They were replayed at zero tokens under a badge reading "From
 * knowledge base" in green.
 *
 * Found by reading a demo transcript on 2026-08-31, not by a failing test.
 * "What does the brand ambassador training cover" returned generic dealership
 * boilerplate with nothing to do with this client, while the client's actual
 * Porsche academy documents sat in the brain unread.
 */
import { pickUsableKnowledge } from "@/lib/assistant";

const row = (over: Record<string, unknown> = {}) =>
  ({ id: "k1", question: "q", answer: "a", source: "human", rating: null, ...over }) as never;

describe("which knowledge entries may answer", () => {
  /* A person wrote it. Waiting for a rating does not make it truer. */
  it("keeps an unrated entry a person wrote", () => {
    expect(pickUsableKnowledge([row({ source: "human" })])).toHaveLength(1);
    expect(pickUsableKnowledge([row({ source: "docs" })])).toHaveLength(1);
  });

  /* THE ONE THAT SHIPPED. A model improvisation laundered into a cited fact
     about the client's own business. */
  it("refuses an unrated entry a model wrote", () => {
    expect(pickUsableKnowledge([row({ source: "ai" })])).toEqual([]);
  });

  /* A rating IS a person saying it was right, whoever drafted it. */
  it("keeps a model-written entry once somebody rated it well", () => {
    expect(pickUsableKnowledge([row({ source: "ai", rating: 4 })])).toHaveLength(1);
  });

  it("still refuses anything graded badly, whoever wrote it", () => {
    expect(pickUsableKnowledge([row({ source: "human", rating: 2 })])).toEqual([]);
    expect(pickUsableKnowledge([row({ source: "ai", rating: 1 })])).toEqual([]);
  });

  it("keeps the good ones when the list is mixed", () => {
    const usable = pickUsableKnowledge([
      row({ id: "a", source: "ai" }),
      row({ id: "b", source: "docs" }),
      row({ id: "c", source: "ai", rating: 5 }),
    ]);
    expect(usable.map((u) => (u as { id: string }).id)).toEqual(["b", "c"]);
  });
});
