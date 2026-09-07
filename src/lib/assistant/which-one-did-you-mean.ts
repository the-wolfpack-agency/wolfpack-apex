/**
 * We found documents. We could not tell which one you meant. Ask.
 *
 * WHAT THIS REPLACES
 *
 * "When do we have to pay?" retrieves five real documents from the reader's own
 * library. A relevance judge then decides none of them answers THAT question,
 * which is fair: pay for what? The retrieval is discarded, the quality gate
 * sees an empty context and rejects, and the reader is told:
 *
 *   "I don't have a confident answer for that. Could you rephrase, or open a
 *    support ticket so a human can look at it?"
 *
 * Measured against the deployed URL 2026-08-29. Two things wrong with it.
 *
 * IT IS NOT TRUE. We did not come up empty. We are holding several documents
 * about payment and cannot tell which agreement they meant, which is a
 * completely different situation and has a completely different remedy.
 *
 * IT SENDS THEM TO A HUMAN over a question a human would answer in four words:
 * "which contract do you mean?" On a first day that reads as a product that
 * does not work, and it is the most expensive possible outcome for a support
 * queue that exists to handle real problems.
 *
 * A colleague who had read everything would not refuse. They would say "I have
 * the Acme SOW and two invoices here, which one?" That is all this does.
 *
 * WHY IT IS NOT A GUESS. The alternative is answering from the best-scoring
 * document anyway, which is exactly the confidently-wrong failure the judge
 * exists to prevent. Naming the candidates commits to nothing and moves the
 * reader forward, which a refusal does not.
 */

/** How many to offer. More than four is a list to read, not a choice to make. */
const MAX_CHOICES = 4;

/**
 * A filename as somebody would say it out loud.
 *
 * Real corpora are full of "viaPeople Work Order_Wolfpack Agency_360
 * Feedback_5-7-25[36].docx.pdf". Offering that verbatim asks somebody to pick
 * between two strings of punctuation.
 */
export function readableDocumentName(filename: string): string {
  const withoutPath = filename.split("/").pop() ?? filename;
  return (
    withoutPath
      /* Repeated extensions are an artefact of conversion: .docx.pdf. */
      .replace(/(\.[a-z0-9]{2,5})+$/i, "")
      /* Bracketed counters from duplicate downloads: [36], (2). */
      .replace(/[[(]\d+[\])]/g, " ")
      /* Trailing date stamps in the filename add nothing to a choice. */
      .replace(/[_\-\s]\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4}\s*$/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || withoutPath
  );
}

export interface WhichOne {
  answer: string;
  /** The documents offered, readable, in the order shown. */
  choices: string[];
}

/**
 * Build the question, or return null when there is nothing to offer.
 *
 * Null is the important case: with no candidates this must NOT invent a
 * friendlier refusal. A reader told "which of these did you mean" followed by
 * nothing is worse off than one told plainly that we found nothing.
 */
export function whichOneDidYouMean(
  question: string,
  documents: Array<string | { name: string; url?: string | null }>,
): WhichOne | null {
  /* Accept a bare filename OR a {name, url}. A caller that holds the
     document's web URL passes it so the name renders as a clickable link to
     the file — the SAME way every other answer path shows a source. A plain
     string still works (renders as bold text, no link). */
  const items = documents.map((d) =>
    typeof d === "string"
      ? { name: d, url: null as string | null }
      : { name: d.name, url: d.url ?? null },
  );

  /* Filtered on real content, not on truthiness: readableDocumentName falls
     back to the original when stripping would empty it, and a whitespace
     filename is truthy while being unpickable. Dedupe by the readable name,
     keeping the first URL seen for it. */
  const readable: Array<{ name: string; url: string | null }> = [];
  const seen = new Set<string>();
  for (const it of items) {
    const name = readableDocumentName(it.name);
    if (name.trim().length === 0 || seen.has(name)) continue;
    seen.add(name);
    readable.push({ name, url: it.url });
    if (readable.length >= MAX_CHOICES) break;
  }
  if (readable.length === 0) return null;

  /* The readable name, as a link to the file when we hold its URL. */
  const fmt = (r: { name: string; url: string | null }) =>
    r.url ? `[${r.name}](${r.url})` : `**${r.name}**`;

  /* One candidate is not a choice. Saying "did you mean X" when X is the only
     thing there is asks a question we already know the answer to; better to
     name it and let them confirm by asking again about it. */
  /* HONEST ABOUT WHAT THESE ARE.
   *
   * This said "I found N documents that look related". They are the documents
   * the relevance judge just decided do NOT answer the question, so calling
   * them related claims something we were told is false, and it converts an
   * honest refusal into a menu of wrong answers.
   *
   * Seen doing exactly that on the deployed URL 2026-08-29: asked "when do we
   * have to pay?" it offered a UPS invoice and three date-stamped receipts as
   * things that "look related". A client evaluating four bad options has been
   * given more work than one who was simply told we could not answer.
   *
   * So it says what is true: no clear answer, here is the closest material,
   * and you decide whether any of it is the one. That is a weaker claim and a
   * more useful one. */
  const lead =
    readable.length === 1
      ? `I could not find a clear answer. The closest thing I hold is ${fmt(readable[0])}.`
      : `I could not find a clear answer to that. The closest things I hold are:`;

  const list = readable.length === 1 ? "" : `\n\n${readable.map((r) => `- ${fmt(r)}`).join("\n")}`;

  return {
    answer:
      `${lead}${list}\n\n` +
      /* Names the next move rather than asking them to "rephrase", which is a
         request to guess what we wanted. */
      `If one of those is the one you mean, name it and I will read it. ` +
      `If none of them is, it may not be in the documents I can see.`,
    choices: readable.map((r) => r.name),
  };
}
