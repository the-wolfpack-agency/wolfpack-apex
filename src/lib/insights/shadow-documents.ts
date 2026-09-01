/**
 * Documents the business circulated that the knowledge base has never seen.
 *
 * WHAT IT FINDS. A file attached to a meeting or an email is a document
 * somebody thought mattered enough to send. If it never reached the indexed
 * corpus, the assistant cannot answer from it, and nobody knows that except by
 * asking a question and getting nothing.
 *
 * Run against our own data on 2026-08-31: 37 distinct files circulated through
 * meetings and 36 had never been ingested, including a design brief and two
 * spreadsheets. Somebody asking what the CFTR design brief says would be told
 * we hold nothing, while the file sat in a calendar invitation.
 *
 * WHAT IT CAN AND CANNOT CLAIM, and the difference matters because the
 * stronger version is tempting. This says the KNOWLEDGE BASE has never seen a
 * file. It does NOT say the file is missing from SharePoint: it may well be
 * filed correctly and simply never indexed, which is a different fix with a
 * different owner. Claiming the stronger thing would have a client hunting for
 * a document that is exactly where it should be.
 *
 * MATCHING IS BY NAME, WHICH IS APPROXIMATE. A document ingested under a
 * different name reads as missing here. That is the safe direction, since a
 * false positive costs somebody a look and a false negative hides a document
 * nobody can find, but it is a reason to read this as a list to check rather
 * than a list of failures.
 *
 * FURNITURE IS EXCLUDED, and on real data it was most of the list. Six of the
 * first twelve findings were image001.gif through image006.gif: the images
 * inside people's email signatures, attached to every message anybody sends.
 * Reporting a signature logo as an uningested business document is how a
 * report gets skimmed and closed.
 */

export interface CirculatedFile {
  filename: string;
  mime: string | null;
  sizeBytes?: number | null;
  /** Where it was seen, so somebody can go and look. */
  seenIn?: string | null;
}

/**
 * Files that are part of a message rather than a document sent in one.
 *
 * Names first, because the pattern is unmistakable and universal: every mail
 * client in existence numbers inline images this way.
 */
const INLINE_IMAGE = /^image\d{3,}\.(?:gif|png|jpe?g|bmp)$/i;
/** Tracking pixels, logos, and the rest of a signature block. */
const SIGNATURE_ISH = /^(?:logo|signature|spacer|divider|banner|icon|footer)[-_\s]?\d*\.(?:gif|png|jpe?g|svg)$/i;
/** A calendar attachment describing the meeting, not a document from it. */
const CALENDAR_PART = /\.(?:ics|vcf)$/i;

/**
 * Below this a file is decoration rather than content.
 *
 * Twelve kilobytes. Generous on purpose: a one-page scanned memo can be small,
 * and losing it to save a logo would be the wrong trade.
 */
export const MIN_DOCUMENT_BYTES = 12_000;

export function isLikelyDocument(file: CirculatedFile): boolean {
  const name = file.filename.trim();
  if (!name) return false;
  if (INLINE_IMAGE.test(name)) return false;
  if (SIGNATURE_ISH.test(name)) return false;
  if (CALENDAR_PART.test(name)) return false;

  /* An image that is NOT named like an inline one may be a scan or a
     screenshot somebody meant to share, so size decides rather than type. */
  const mime = (file.mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) {
    return typeof file.sizeBytes === "number" ? file.sizeBytes >= MIN_DOCUMENT_BYTES : false;
  }
  /* HTML IS KEPT, EVEN THOUGH SOME OF IT IS THE EMAIL BODY.
   *
   * A rule was written to drop it and immediately dropped
   * CFTR_Design_Brief.html, a real design brief, while keeping nothing
   * useful. An email body part and a document saved as HTML are not reliably
   * distinguishable by name: "aidan_mulready (1).html" and
   * "CFTR_Design_Brief.html" differ only in a way a person can see.
   *
   * So it stays in. A false positive costs somebody a second to dismiss; a
   * design brief silently deleted by a clever rule is never seen again, and
   * the whole output is framed as a list to check rather than a list of
   * failures. */
  return true;
}

export interface ShadowDocument extends CirculatedFile {
  /** Why it is worth looking at, in the words a person would use. */
  because: string;
}

export interface ShadowReading {
  shadow: ShadowDocument[];
  /** Circulated and already indexed. Nothing to do. */
  known: CirculatedFile[];
  /** Excluded as part of a message rather than a document sent in one. */
  furniture: CirculatedFile[];
}

/**
 * Split circulated files by whether the knowledge base has seen them.
 *
 * `indexedNames` is passed in rather than read here so the judgment is
 * testable without a database, which is where the mistakes would be.
 */
export function findShadowDocuments(
  circulated: readonly CirculatedFile[],
  indexedNames: ReadonlySet<string>,
): ShadowReading {
  const norm = (s: string) => s.trim().toLowerCase();
  const indexed = new Set([...indexedNames].map(norm));

  const shadow: ShadowDocument[] = [];
  const known: CirculatedFile[] = [];
  const furniture: CirculatedFile[] = [];
  const seen = new Set<string>();

  for (const file of circulated) {
    const key = norm(file.filename);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (!isLikelyDocument(file)) {
      furniture.push(file);
      continue;
    }
    /* Also matched without the extension, because the same document arrives
       as a pdf in one place and a docx in another and it is the same
       document. */
    const stem = key.replace(/\.[a-z0-9]+$/i, "");
    const isIndexed = [...indexed].some((n) => n === key || n.startsWith(stem));
    if (isIndexed) {
      known.push(file);
      continue;
    }
    shadow.push({
      ...file,
      because: file.seenIn
        ? `Circulated in ${file.seenIn} and never indexed, so no answer can cite it.`
        : "Circulated and never indexed, so no answer can cite it.",
    });
  }

  return { shadow, known, furniture };
}

/** What a person reads first. */
export function describeShadow(r: ShadowReading): string {
  const total = r.shadow.length + r.known.length;
  if (total === 0) {
    return "No circulated files were found to compare against the knowledge base.";
  }
  const lines = [
    `${r.shadow.length} of ${total} document(s) that circulated have never reached the knowledge base.`,
  ];
  if (r.shadow.length > 0) {
    lines.push(
      ``,
      /* The weaker claim, stated deliberately. The stronger one would have a
         client hunting for a document that is exactly where it should be. */
      `That means no answer can cite them. It does NOT mean they are missing from SharePoint: a file can be filed correctly and simply never indexed, which is a different fix.`,
      ``,
      `Matched by filename, so a document indexed under another name will appear here. Read it as a list to check.`,
    );
  }
  if (r.furniture.length > 0) {
    lines.push(
      ``,
      `${r.furniture.length} attachment(s) were excluded as part of a message rather than a document sent in one, mostly the images inside email signatures.`,
    );
  }
  return lines.join("\n");
}
