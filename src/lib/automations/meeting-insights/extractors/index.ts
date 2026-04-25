/**
 * Attachment text extractor — MIME dispatcher.
 *
 * The single public entry point for Stream A's ingest orchestrator:
 * pass bytes + the message attachment's mime + filename and get back
 * `{ text, status }`.
 *
 *   `extracted`         — text is non-null (possibly empty for image-only
 *                          PDFs, but the extractor ran cleanly)
 *   `unsupported_mime`  — we have no extractor for this mime; bytes are
 *                          still persisted by Stream A so a future
 *                          extractor can be slotted in here without
 *                          re-ingesting
 *   `error`             — extractor threw (corrupt bytes, password-
 *                          protected PDF, malformed docx, etc.). Never
 *                          surfaces an exception to the caller — the
 *                          ingest path must never crash on a single
 *                          bad attachment.
 *
 * Adding a new MIME: write `extractors/<kind>.ts` that exports an
 * AttachmentExtractor, then add a case to `dispatch()` below. No other
 * code changes required.
 *
 * Filename is currently unused — it's threaded through so future
 * extractors can disambiguate by extension when the MIME is the generic
 * `application/octet-stream` Outlook sometimes hands us.
 */

import type { AttachmentExtractor } from "../types";
import { extractText } from "./text";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractHtml } from "./html";

export { extractText, extractDocx, extractPdf, extractHtml };

/**
 * MIME → extractor table. Lower-cased on lookup; we accept the obvious
 * synonyms (text/markdown <-> text/x-markdown).
 */
const MIME_TABLE: Readonly<Record<string, AttachmentExtractor>> = {
  "text/plain": extractText,
  "text/markdown": extractText,
  "text/x-markdown": extractText,
  "text/csv": extractText,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    extractDocx,
  "application/pdf": extractPdf,
  "text/html": extractHtml,
};

function lookupExtractor(mime: string): AttachmentExtractor | null {
  const key = (mime ?? "").toLowerCase().split(";")[0].trim();
  return MIME_TABLE[key] ?? null;
}

/** True if `extractAttachmentText` knows how to extract this MIME. */
export function isSupportedMime(mime: string): boolean {
  return lookupExtractor(mime) !== null;
}

export const extractAttachmentText: AttachmentExtractor = async (
  bytes,
  mime,
  filename,
) => {
  const extractor = lookupExtractor(mime);
  if (!extractor) {
    return { text: null, status: "unsupported_mime" };
  }
  // Each extractor wraps its own try/catch and returns a typed result;
  // the dispatcher itself is exception-safe by construction. We add an
  // outer try/catch as a belt-and-suspenders guard so a future extractor
  // that forgets to wrap can never crash the ingest path.
  try {
    return await extractor(bytes, mime, filename);
  } catch {
    return { text: null, status: "error" };
  }
};

export default extractAttachmentText;
