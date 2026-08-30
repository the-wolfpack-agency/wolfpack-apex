/**
 * A quote should start at a word and end at a thought.
 *
 * WHAT THIS FIXES, MEASURED 2026-08-30 on the real assistant. Asking "what are
 * the payment terms in our SOW?" quoted:
 *
 *   > tation and Project Management fees: 50% ($6,000.00) is due within 30
 *     days of the execution of this Work Order. Final payment of the remai
 *
 * Both ends are wrong. It opens mid-word on the tail of "Documentation" and
 * stops mid-word on "remainder". The content is exactly right and the framing
 * makes it read like the product is damaged, which is the worst kind of defect
 * in a client demo: nothing is broken, and it looks broken.
 *
 * The cause is that chunk boundaries are chosen for embedding quality and a
 * fixed character budget is applied on top, and neither has any idea where
 * words are. Chunking is not going to change: it is tuned for retrieval and
 * retrieval works. The quote is a presentation concern and belongs here.
 */

/** Sentence-ending punctuation followed by a space, the usual way out. */
const SENTENCE_END = /[.!?]["')\]]?\s/g;

/**
 * How far in from a raw edge it is worth hunting for a clean boundary.
 *
 * Wide enough to clear a long word or a short clause, narrow enough that the
 * quote never loses a meaningful amount of what was matched.
 */
const HUNT = 120;

export interface QuoteWindow {
  text: string;
  /** True when text was dropped from the front to reach a word boundary. */
  trimmedStart: boolean;
  /** True when there is more document after this. */
  trimmedEnd: boolean;
}

/**
 * Trim a raw excerpt to something a person can read aloud.
 *
 * Never grows the excerpt and never reaches back into the source, so it cannot
 * surface text the caller had not already decided to show. Redaction and
 * injection-neutralising still happen on the caller's side, on the text this
 * returns.
 */
export function quoteWindow(raw: string, budget: number): QuoteWindow {
  const source = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!source) return { text: "", trimmedStart: false, trimmedEnd: false };

  /* THE FRONT. A chunk that begins mid-word begins with a word fragment, so
     drop up to the first space. Only when there IS one within the hunt window:
     a chunk that legitimately starts with a very long token should not lose
     it. */
  let start = 0;
  const firstSpace = source.indexOf(" ");
  if (firstSpace > 0 && firstSpace <= HUNT && /^\S/.test(source)) {
    /* Only trim when the opening token looks like debris rather than a word:
       lowercase and glued to what follows is the signature of a split word. */
    const opening = source.slice(0, firstSpace);
    if (/^[a-z]/.test(opening)) start = firstSpace + 1;
  }

  const body = source.slice(start);
  if (body.length <= budget) {
    return { text: body, trimmedStart: start > 0, trimmedEnd: false };
  }

  /* THE BACK. Prefer a sentence end inside the budget; fall back to a word
     boundary; only cut mid-word if the text offers neither, which means it is
     one enormous token and there is nothing better to do. */
  const window = body.slice(0, budget);

  let cut = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(window); m; m = SENTENCE_END.exec(window)) {
    if (m.index >= budget - HUNT) cut = m.index + m[0].trimEnd().length;
  }
  if (cut === -1) {
    const lastSpace = window.lastIndexOf(" ");
    if (lastSpace > budget - HUNT) cut = lastSpace;
  }
  if (cut === -1) cut = budget;

  return { text: window.slice(0, cut).trim(), trimmedStart: start > 0, trimmedEnd: true };
}
