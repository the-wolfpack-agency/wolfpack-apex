/**
 * text/html attachment extractor.
 *
 * Reuses `htmlToPlainText` from `parser-email-body` so the email body
 * and HTML attachments produce identical text for the same input. Pure
 * cheerio under the hood; same DRY guarantee.
 *
 * On any cheerio throw (extremely rare; cheerio is tolerant) → `error`.
 */
import { htmlToPlainText } from "../parser-email-body";
import type { AttachmentExtractor } from "../types";

export const extractHtml: AttachmentExtractor = async (bytes) => {
  try {
    const raw = bytes.toString("utf8");
    return { text: htmlToPlainText(raw), status: "extracted" };
  } catch {
    return { text: null, status: "error" };
  }
};

export default extractHtml;
