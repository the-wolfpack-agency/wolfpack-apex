/**
 * The pieces query expansion is wired from, and the cost regression it invites.
 *
 * WHY THIS FILE. Wiring expansion put a relevance judge INSIDE retrieve(),
 * while one already ran after it. Two judges shaped differently are two judges
 * that can disagree about the same passages, and two judges shaped identically
 * are one bill paid twice. Both failures are invisible: the answer still comes
 * back and the tests still pass.
 */

import { strongHits, judgeMaterial, HITS_JUDGED } from "@/lib/brain/strong-hits";
import { expandQuestion, EXPANSION_SYSTEM, parseExpansion } from "@/lib/brain/expand-query";
import { RELEVANCE_MATERIAL_PER_HIT } from "@/lib/brain/relevance";
import { SEMANTIC_SCORE_FLOOR } from "@/lib/brain/qdrant";

const hit = (score: number, source: string, content = "x".repeat(5000)) => ({
  score,
  source,
  content,
});

describe("which passages the judge is shown", () => {
  /* Semantic is exempt from the subject-word test but not from being close.
     For one afternoon the floor did not exist and every query came back with
     five confident hits, which is why this is checked twice. */
  it("keeps semantic hits at or above the floor and drops the rest", () => {
    const hits = [hit(SEMANTIC_SCORE_FLOOR, "semantic"), hit(SEMANTIC_SCORE_FLOOR - 0.01, "semantic")];
    expect(strongHits(hits, false)).toHaveLength(1);
  });

  /* A question too short to quote from cannot carry a keyword hit, however
     well it scores. */
  it("drops keyword hits when the question carries nothing to quote", () => {
    const hits = [hit(0.9, "keyword")];
    expect(strongHits(hits, false)).toHaveLength(0);
    expect(strongHits(hits, true)).toHaveLength(1);
  });

  /* THE 123-REFUSAL BUG. The judge saw 500 characters of a 2,600-character
     passage and ruled correctly on what it had been shown, which was not the
     evidence. The limit has to cover a whole median chunk. */
  it("shows the judge enough of each passage to rule on", () => {
    const material = judgeMaterial([hit(0.9, "keyword")]);
    expect(material.length).toBe(RELEVANCE_MATERIAL_PER_HIT);
    expect(RELEVANCE_MATERIAL_PER_HIT).toBeGreaterThan(2000);
  });

  it("shows at most three passages", () => {
    const many = Array.from({ length: 9 }, () => hit(0.9, "keyword", "abc"));
    expect(judgeMaterial(many).split("\n\n")).toHaveLength(HITS_JUDGED);
  });

  it("produces nothing when nothing is strong", () => {
    expect(judgeMaterial([])).toBe("");
  });
});

describe("asking for better words", () => {
  it("sends the question and returns the rewrite", async () => {
    const seen: { system: string; prompt: string }[] = [];
    const out = await expandQuestion("what are the payment terms in our sow?", async (input) => {
      seen.push({ system: input.system, prompt: input.prompt });
      return "invoice settlement net 30 work order";
    });
    expect(out).toBe("invoice settlement net 30 work order");
    expect(seen[0].system).toBe(EXPANSION_SYSTEM);
    expect(seen[0].prompt).toBe("what are the payment terms in our sow?");
  });

  /* THE WHOLE ERROR POLICY. A rewrite is an optimization, so a rewrite that
     throws must cost the question nothing: returning the original makes
     retrieve() skip the second search, and the reader gets exactly what they
     would have got anyway. */
  it("falls back to the original when the model fails", async () => {
    const out = await expandQuestion("the original question", async () => {
      throw new Error("provider down");
    });
    expect(out).toBe("the original question");
  });

  it("falls back when the model preambles instead of answering", async () => {
    /* "Sure, here are the terms:" retrieves worse than the original. */
    const out = await expandQuestion("q", async () => "");
    expect(out).toBe("q");
  });

  it("does not call the model for an empty question", async () => {
    let called = false;
    await expandQuestion("   ", async () => {
      called = true;
      return "anything";
    });
    expect(called).toBe(false);
  });

  it("cleans a reply that explains itself", () => {
    expect(parseExpansion("Sure! Here are the terms:\npayment net 30 invoice", "orig")).toBe(
      "payment net 30 invoice",
    );
  });
});

/**
 * When a rewrite is worth buying.
 *
 * THE BUG THESE EXIST FOR. shouldExpand compared the top score against the
 * SEMANTIC floor without asking which scale the score was on. A semantic score
 * is a cosine similarity; a keyword score is a text rank, and the retriever
 * treats 0.05 as the bar for a keyword hit worth quoting. So every keyword top
 * sat an order of magnitude under a floor that was never about it.
 *
 * Measured on 30 real queries that had already found something: 26 would have
 * bought a rewrite. That is a model call and about two seconds added to
 * almost every question in the product, to rescue questions that were not
 * failing.
 */
import { shouldExpand } from "@/lib/brain/expand-query";

const FLOOR = 0.36;

describe("when a rewrite is worth buying", () => {
  it("does not fire on a keyword hit merely because it is under the semantic floor", () => {
    expect(
      shouldExpand({ hitCount: 5, topScore: 0.12, topIsSemantic: false }, FLOOR),
    ).toBe(false);
  });

  it("still fires on a weak SEMANTIC hit, which the floor is actually about", () => {
    expect(
      shouldExpand({ hitCount: 5, topScore: 0.12, topIsSemantic: true }, FLOOR),
    ).toBe(true);
  });

  it("does not fire on a strong semantic hit", () => {
    expect(shouldExpand({ hitCount: 5, topScore: 0.8, topIsSemantic: true }, FLOOR)).toBe(false);
  });

  /* THE SIGNAL EXPANSION EXISTS FOR, and the one that still catches a wrong
     keyword result: a confident retrieval from the wrong place is invisible to
     every number here, and the judge says so out loud. */
  it("fires whatever the scale when the judge rejected the material", () => {
    expect(
      shouldExpand({ hitCount: 5, topScore: 0.9, topIsSemantic: false, judgedIrrelevant: true }, FLOOR),
    ).toBe(true);
  });

  it("fires when nothing came back at all", () => {
    expect(shouldExpand({ hitCount: 0, topScore: 0, topIsSemantic: false }, FLOOR)).toBe(true);
  });

  /* Absent means unknown, and treating unknown as semantic would reinstate the
     bug for every caller that has not been updated. */
  it("treats a missing scale as not-semantic", () => {
    expect(shouldExpand({ hitCount: 5, topScore: 0.12 }, FLOOR)).toBe(false);
  });
});
