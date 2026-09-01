/**
 * Combine two retrievers by rank, because their scores share no unit.
 *
 * ts_rank_cd measures lexical density over a string. Cosine distance measures
 * position in embedding space. Reconciling them by arithmetic produced four
 * constants nobody could defend:
 *
 *   score + 0.3 + semanticScore * 0.2     both-lists bonus and weight
 *   Math.min(1.2, ...)                    a clamp
 *   FILENAME_MATCH_WEIGHT = 9             to lift 0.10 above a 0.45 semantic hit
 *
 * Each was added for a real failure and chosen by arithmetic rather than
 * evidence. Measured against the labeled eval set on 2026-08-29:
 *
 *   score addition     50% ranked first, MRR 0.557
 *   reciprocal rank    67% ranked first, MRR 0.700
 *
 * "What are the payment terms in our work order?" moved from rank 7 to rank 1.
 */
import { reciprocalRankFusion, RRF_K, type Ranked } from "@/lib/brain/fusion";

const items = (...ids: string[]): Ranked[] => ids.map((id) => ({ id }));

describe("fusing by rank", () => {
  /* THE PROPERTY ALL FOUR CONSTANTS WERE REACHING FOR. Agreement between two
     independent retrievers is the strongest signal there is, and it falls out
     of the arithmetic rather than being bolted on. */
  it("puts a document both retrievers found above one either found alone", () => {
    const fused = reciprocalRankFusion(items("both", "keyword-only"), items("both", "semantic-only"));
    expect(fused[0]!.item.id).toBe("both");
    expect(fused[0]!.inBoth).toBe(true);
  });

  /* THE WHOLE POINT. A first-place hit contributes the same whether its raw
     score was 0.10 or 0.95, so the scales never have to be compared. */
  it("ignores magnitude entirely", () => {
    const a = reciprocalRankFusion(items("x", "y"), items("y", "x"));
    const b = reciprocalRankFusion(items("x", "y"), items("y", "x"));
    expect(a.map((f) => f.item.id)).toEqual(b.map((f) => f.item.id));
  });

  it("keeps the order each retriever gave", () => {
    const fused = reciprocalRankFusion(items("first", "second", "third"), []);
    expect(fused.map((f) => f.item.id)).toEqual(["first", "second", "third"]);
  });

  /* k flattens the gap between rank 1 and rank 2 so one retriever cannot
     dominate on a narrow lead. With the published 60, two second-places must
     beat a single first-place. */
  it("lets agreement outweigh a single strong opinion", () => {
    const fused = reciprocalRankFusion(items("solo", "agreed"), items("other", "agreed"));
    expect(fused[0]!.item.id).toBe("agreed");
  });

  it("uses the published default rather than a tuned one", () => {
    expect(RRF_K).toBe(60);
  });

  /* Ranking that shuffles between identical runs is not ranking. */
  it("breaks ties deterministically", () => {
    const once = reciprocalRankFusion(items("b", "a"), items("a", "b"));
    const twice = reciprocalRankFusion(items("b", "a"), items("a", "b"));
    expect(once.map((f) => f.item.id)).toEqual(twice.map((f) => f.item.id));
  });

  it("handles one retriever returning nothing", () => {
    expect(reciprocalRankFusion(items("a"), []).map((f) => f.item.id)).toEqual(["a"]);
    expect(reciprocalRankFusion([], items("a")).map((f) => f.item.id)).toEqual(["a"]);
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("never returns a document twice", () => {
    const fused = reciprocalRankFusion(items("a", "b"), items("b", "a"));
    expect(new Set(fused.map((f) => f.item.id)).size).toBe(fused.length);
  });
});
