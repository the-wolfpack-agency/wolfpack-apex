/**
 * .docx attachment extractor.
 *
 * History: this used to call `mammoth.extractRawText`, but mammoth's
 * internal XML parser breaks against this repo's `@xmldom/xmldom` 0.9.x
 * override (mammoth was written for 0.8.x; the 0.9 release made the
 * mimeType arg required on `DOMParser.parseFromString` and mammoth never
 * updated its call sites). Every real .docx failed with
 *   "DOMParser.parseFromString: the provided mimeType 'undefined' is not
 *    valid"
 * so extraction silently returned `error` for valid documents.
 *
 * Fix: reuse the dependency-free `docxBufferToMarkdown` extractor that
 * `src/lib/principles/parser.ts` already adopted for exactly this reason
 * (pure JSZip + regex over `word/document.xml`, no mammoth, no xmldom).
 * DRY: one docx→text path for the whole repo. The markdown it emits is,
 * for plain paragraphs, the plain text we need here; heading/bold markers
 * are harmless for downstream meeting analysis.
 *
 * Returns `extracted` with the text on success; on any throw (corrupt
 * zip, missing word/document.xml, empty buffer) returns `error` so the
 * dispatcher surfaces a clean status to Stream A - never throws.
 */
import type { AttachmentExtractor } from "../types";
import { docxBufferToMarkdown } from "@/lib/principles/parser";

export const extractDocx: AttachmentExtractor = async (bytes) => {
  try {
    // JSZip's loadAsync wants a Buffer/Uint8Array; AttachmentExtractor
    // hands us a Buffer already.
    const text = await docxBufferToMarkdown(Buffer.from(bytes));
    return { text, status: "extracted" };
  } catch {
    return { text: null, status: "error" };
  }
};

export default extractDocx;
