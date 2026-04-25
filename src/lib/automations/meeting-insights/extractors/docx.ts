/**
 * .docx attachment extractor — uses mammoth (already in package.json).
 *
 * Dynamic import keeps mammoth out of bundles for routes that never call
 * it. Returns `extracted` with the raw text on success; on any throw
 * (corrupt zip, malformed OOXML, unsupported sub-format), returns
 * `error` so the dispatcher can surface a clean status to Stream A.
 */
import type { AttachmentExtractor } from "../types";

export const extractDocx: AttachmentExtractor = async (bytes) => {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    const text = (result.value ?? "").toString();
    // mammoth returns the empty string for an empty doc — that is still
    // a successful extraction.
    return { text, status: "extracted" };
  } catch {
    return { text: null, status: "error" };
  }
};

export default extractDocx;
