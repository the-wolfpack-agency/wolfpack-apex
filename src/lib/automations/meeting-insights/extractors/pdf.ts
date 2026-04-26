/**
 * application/pdf attachment extractor — uses unpdf (already in
 * package.json).
 *
 * Why unpdf and not pdf-parse: unpdf is the existing repo standard
 * (see `src/lib/brain/extractor.ts` and `src/lib/benefits.ts`). It runs
 * on the Vercel runtime without native modules. pdf-parse pulls a
 * different dependency tree we don't want.
 *
 * Image-only / scanned PDFs return `extracted` with an empty string —
 * downstream consumers can detect "no extractable text" and Phase 2 OCR
 * can be slotted in here when we add it. No exception thrown.
 *
 * Any unpdf throw (malformed PDF, password-protected) → `error`.
 *
 * Testability: unpdf uses a dynamic ES module import that ts-jest
 * cannot evaluate without `--experimental-vm-modules`. To keep the
 * jest config simple and our tests using real PDF bytes, we expose a
 * `makeExtractPdfWith(reader)` factory; the default export uses unpdf,
 * tests inject a `pdfjs-dist`-style reader.
 */
import type { AttachmentExtractor } from "../types";

/** A minimal PDF text reader. Tests can inject a stub. */
export type PdfTextReader = (
  bytes: Buffer,
) => Promise<string>;

const defaultReader: PdfTextReader = async (bytes) => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const uint8 = new Uint8Array(bytes);
  const pdf = await getDocumentProxy(uint8);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : (text ?? "");
};

export function makeExtractPdfWith(reader: PdfTextReader): AttachmentExtractor {
  return async (bytes) => {
    try {
      const text = await reader(bytes);
      return { text, status: "extracted" };
    } catch (e) {
      if (process.env.MEETING_INSIGHTS_DEBUG) {
         
        console.error("[meeting-insights/pdf]", e);
      }
      return { text: null, status: "error" };
    }
  };
}

export const extractPdf: AttachmentExtractor = makeExtractPdfWith(defaultReader);

export default extractPdf;
