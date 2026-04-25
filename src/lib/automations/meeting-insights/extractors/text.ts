/**
 * Plain-text / markdown / csv attachment extractor.
 *
 * Trivial wrapper: decode utf-8 and return. We don't trim — preserving
 * trailing newlines lets the LLM analyzer (Phase 2) detect intentional
 * formatting. Empty bytes still return `extracted` with empty string;
 * the analyzer's job, not ours, to decide what "useful" content is.
 */
import type { AttachmentExtractor } from "../types";

export const extractText: AttachmentExtractor = async (bytes) => {
  try {
    const text = bytes.toString("utf8");
    return { text, status: "extracted" };
  } catch {
    return { text: null, status: "error" };
  }
};

export default extractText;
