/**
 * Which retrieved passages are close enough to be worth judging.
 *
 * WHY THIS IS ITS OWN FILE NOW. The filter and the material it produces were
 * written inline in the assistant, immediately before the relevance judge.
 * Wiring query expansion means a judge also has to run INSIDE retrieve(), and
 * two judges that see differently-shaped material are two judges that can
 * disagree about the same passages.
 *
 * That is not hypothetical here. This product has already shipped a bug where
 * the judge saw 500 characters of a 2,600-character passage and ruled
 * correctly on what it had been shown, which was not the evidence. It fired
 * 123 times in four days. Duplicating the shaping to wire a feature would be
 * the same failure with a second copy to keep in step.
 *
 * So both callers use these, and there is one definition of what the judge
 * looks at.
 */

import { SEMANTIC_SCORE_FLOOR } from "./qdrant";
import { RELEVANCE_MATERIAL_PER_HIT } from "./relevance";

/** The shape both callers need: enough to score and to quote. */
export interface ScorableHit {
  score: number;
  source: string;
  content: string;
}

/** How many passages the judge is shown. */
export const HITS_JUDGED = 3;

/**
 * Passages close enough to be worth an opinion.
 *
 * Semantic is exempt from the subject-word test but not from having to be
 * close: Qdrant already refuses anything under the floor, and this repeats the
 * check because the exemption is only safe while that floor exists. For one
 * afternoon it did not, and every query on record came back with five
 * confident hits.
 */
export function strongHits<T extends ScorableHit>(hits: readonly T[], quotable: boolean): T[] {
  return hits.filter((h) => {
    if (h.source.includes("semantic")) return h.score >= SEMANTIC_SCORE_FLOOR;
    return quotable && h.score >= 0.05;
  });
}

/**
 * The text the judge rules on.
 *
 * Sized to the corpus rather than guessed: the per-hit limit covers a whole
 * median chunk and nearly the longest one. Three hits is roughly 7,000
 * characters, a fraction of a cent on the cheap tier, and starving it is what
 * produced the 123 wrong refusals.
 */
export function judgeMaterial(hits: readonly ScorableHit[]): string {
  return hits
    .slice(0, HITS_JUDGED)
    .map((h) => h.content.slice(0, RELEVANCE_MATERIAL_PER_HIT))
    .join("\n\n");
}
