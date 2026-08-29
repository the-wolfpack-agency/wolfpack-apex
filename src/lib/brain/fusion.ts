/**
 * Combine keyword and semantic results by RANK, not by score.
 *
 * WHY THE SCORES CANNOT BE ADDED
 *
 * ts_rank_cd measures lexical density over a string. Cosine distance measures
 * position in embedding space. They share no unit, no range and no meaning, and
 * every attempt to reconcile them by arithmetic ends in constants nobody can
 * defend. This codebase had four:
 *
 *   score + 0.3 + semanticScore * 0.2     both-lists bonus and weight
 *   Math.min(1.2, ...)                    a clamp to stop it exceeding 1
 *   FILENAME_MATCH_WEIGHT = 9             to lift 0.10 above a 0.45 semantic hit
 *
 * Each was added for a real failure and each was chosen by arithmetic rather
 * than evidence: 9 is 9 because 0.1 x 9 clears 0.45, and nothing said whether 6
 * or 12 would serve real questions better.
 *
 * RECIPROCAL RANK FUSION TAKES THE ORDER AND DISCARDS THE MAGNITUDE. A document
 * ranked first by either retriever scores 1/(k+1) from that retriever, whatever
 * the raw number was, and a document ranked well by BOTH sums to more than
 * either alone. That is the property all four constants were reaching for, and
 * it needs no scale to be comparable because it never compares them.
 *
 * It is the standard answer to this problem rather than a local invention,
 * which matters for a component every later module will inherit.
 *
 * K IS THE ONE REMAINING NUMBER, and it is a documented default rather than a
 * tuned one. 60 is the value from the original TREC work and is what every
 * implementation uses; it flattens the difference between rank 1 and rank 2 so
 * a single retriever cannot dominate on a narrow lead. Changing it is a
 * decision somebody should have to argue for, which is why it is named.
 */

/** The published default. Not tuned here, and not a knob to reach for. */
export const RRF_K = 60;

export interface Ranked {
  /** Stable identity across both lists. */
  id: string;
}

export interface FusedEntry<T extends Ranked> {
  item: T;
  /** Reciprocal-rank score. Higher is better. Not comparable to a raw score. */
  score: number;
  /** True when both retrievers returned it, which is the strongest signal. */
  inBoth: boolean;
}

/**
 * Fuse two ranked lists.
 *
 * Order within each list is all that is read. Both lists must already be sorted
 * best-first, which is how every retriever returns them.
 */
export function reciprocalRankFusion<T extends Ranked>(
  keyword: readonly T[],
  semantic: readonly T[],
  k: number = RRF_K,
): FusedEntry<T>[] {
  const byId = new Map<string, FusedEntry<T>>();

  const add = (list: readonly T[], fromSemantic: boolean): void => {
    list.forEach((item, index) => {
      const contribution = 1 / (k + index + 1);
      const existing = byId.get(item.id);
      if (existing) {
        existing.score += contribution;
        existing.inBoth = true;
        return;
      }
      byId.set(item.id, { item, score: contribution, inBoth: false });
      /* Marker unused beyond readability; both flags are set on the merge. */
      void fromSemantic;
    });
  };

  add(keyword, false);
  add(semantic, true);

  return [...byId.values()].sort(
    (a, b) =>
      b.score - a.score ||
      /* Deterministic tie-break, so two runs of the same query return the same
         order. Ranking that shuffles is not ranking. */
      a.item.id.localeCompare(b.item.id),
  );
}
