/**
 * When several documents answer equally, say so instead of picking one.
 *
 * THE DEFECT, measured 2026-08-30 against the production corpus:
 *
 *   "how much do we owe upfront?"
 *     -> quoted a chauffeur invoice, confidently, with a dollar figure
 *   "when do we have to pay?"
 *     -> "The closest things I hold are ... name it and I will read it"
 *
 * Same shape of question, opposite behavior, and the first one is a wrong
 * answer delivered with the product's full confidence. Neither question names
 * a subject: "upfront on what?" is what a person would ask back.
 *
 * WHY THE EXISTING GUARD MISSED IT. Disambiguation only fires when the
 * relevance JUDGE rejects the hits. Here the judge accepted them, and it was
 * right to: an invoice genuinely is relevant to owing money. Relevance was
 * never the problem. AGREEMENT was.
 *
 * THE SIGNAL IS WHETHER THE HITS AGREE:
 *
 *   "what are the payment terms in our SOW?"   0.552 0.513 0.468
 *      all three from ONE document, clear leader
 *   "how much do we owe upfront?"              0.419 0.410 0.400
 *      three DIFFERENT documents, no leader, all near the 0.36 floor
 *
 * A question whose best evidence is scattered across unrelated documents at
 * indistinguishable scores has not been answered; it has been guessed at. The
 * honest reply names the candidates, which the product already knows how to
 * write.
 *
 * DELIBERATELY CONSERVATIVE. Asking "which did you mean" when the answer was
 * actually clear is annoying and erodes trust in the answers that are right,
 * so every threshold errs toward answering. A wrong ask costs a click; a
 * confident wrong answer costs the client's belief in the whole product.
 */

export interface ScoredHit {
  document_filename: string;
  score: number;
}

/**
 * How close the runner-up from a DIFFERENT document has to be before the lead
 * stops being a lead. Ten per cent: a document that wins by less than that,
 * on evidence this weak, won by noise.
 */
export const LEAD_MARGIN = 0.1;

/**
 * Above this, a top hit is strong enough to trust on its own even if other
 * documents are close. Set above the observed ambiguous cases (0.42) and below
 * the observed clear one (0.552), then rounded to a number somebody can reason
 * about rather than one fitted to two examples.
 */
export const CONFIDENT_SCORE = 0.5;

/** Fewer than this many distinct documents is not a choice worth offering. */
const MIN_CANDIDATES = 2;

export interface Ambiguity {
  /** Distinct documents that answer about equally well, best first. */
  candidates: string[];
}

/**
 * Decide whether the evidence names one document or several.
 *
 * Returns null when the answer is clear, which is the common case and the one
 * that must stay fast and quiet.
 */
export function detectAmbiguity(hits: ScoredHit[]): Ambiguity | null {
  if (hits.length === 0) return null;

  /* Best score per DOCUMENT. Four chunks of one file is one candidate to the
     person reading, and treating them as four is how a single well-matched
     document looks like a crowd. */
  const best = new Map<string, number>();
  for (const h of hits) {
    const name = h.document_filename;
    const score = Number(h.score) || 0;
    if (!best.has(name) || score > best.get(name)!) best.set(name, score);
  }

  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length < MIN_CANDIDATES) return null;

  const [topName, topScore] = ranked[0];
  const [, runnerUpScore] = ranked[1];

  /* A confident leader answers, whatever else is nearby. */
  if (topScore >= CONFIDENT_SCORE) return null;

  /* A clear leader answers too, even on weak evidence: winning by a margin is
     what "the right document" looks like. */
  if (topScore - runnerUpScore > LEAD_MARGIN) return null;

  /* Weak AND contested. Name them rather than pick one. */
  return {
    candidates: ranked
      .filter(([, s]) => topScore - s <= LEAD_MARGIN)
      .map(([name]) => name)
      .slice(0, 4),
  };
}
