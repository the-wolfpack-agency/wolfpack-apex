/**
 * Email body parser for meeting-insights ingest.
 *
 * Pure function. Takes the raw Microsoft Graph message.body
 * `{ contentType, content }` shape and returns the canonical
 * `{ body_text, body_html }` pair the persistence layer (Stream A) writes.
 *
 * Why we strip HTML rather than persist only the rendered string:
 *   The HTML body is the source of truth for fidelity (we keep it
 *   verbatim), but downstream consumers — search, the calendar-brief
 *   summarizer, the Phase 2 LLM analyzer — all want flat text. Doing the
 *   strip once on ingest costs zero LLM tokens and avoids every reader
 *   re-doing it.
 *
 * Cheerio is already a dependency (used by the porsche-classes
 * Cognito parser). We don't add anything new.
 *
 * Edge cases handled:
 *   - empty body                    → {body_text:"", body_html:null}
 *   - text/plain content            → body_text = content as-is, body_html = null
 *   - text/html content             → body_text = stripped, body_html = original
 *   - HTML with <script>/<style>    → tags + contents removed entirely
 *   - HTML with tables / inline css → cheerio still flattens cleanly
 *   - case-insensitive contentType  → "HTML" vs "html" both accepted
 */

import * as cheerio from "cheerio";
import type { ParsedEmailBody } from "./types";

/** Tags whose contents are NOT visible text and must be removed wholesale. */
const NON_VISIBLE_TAGS = ["script", "style", "noscript", "iframe", "head"];

/**
 * Convert HTML to readable plain text:
 *   1. drop non-visible tags (script/style/etc.)
 *   2. insert a paragraph break for block-level boundaries (<p>, <br>,
 *      <li>, <h1..6>, <tr>) so the output preserves logical paragraphs
 *   3. collapse runs of whitespace, trim leading/trailing space per line
 *   4. drop blank lines beyond a single break (no triple-newlines)
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html);

  // Strip non-visible tags entirely (including their contents).
  for (const tag of NON_VISIBLE_TAGS) {
    $(tag).remove();
  }

  // Insert explicit paragraph delimiters before extracting text.
  // Cheerio's `.text()` concatenates child text nodes with NO whitespace
  // between block elements, so without these markers "<p>A</p><p>B</p>"
  // becomes "AB". We use a sentinel that won't collide with real input.
  const PARA = ""; // ASCII SOH — never appears in body text
  $("br").replaceWith(PARA);
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre").each(
    (_, el) => {
      const $el = $(el);
      $el.append(PARA);
    },
  );

  let text = $("body").length > 0 ? $("body").text() : $.root().text();
  // Replace sentinel with newlines.
  text = text.replace(new RegExp(PARA, "g"), "\n");

  // Normalize whitespace WITHIN each line, then collapse blank-line runs.
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, idx, all) => {
      // Keep non-empty lines, and keep at most ONE empty line between
      // them (so paragraph spacing reads naturally).
      if (line) return true;
      const prev = all[idx - 1];
      return prev !== undefined && prev !== "";
    });

  return lines.join("\n").trim();
}

/**
 * Parse the Microsoft Graph message body shape into the canonical
 * `ParsedEmailBody` the schema persists.
 *
 * `contentType` matching is case-insensitive — Graph normalizes to
 * lowercase but we don't rely on it.
 */
export function parseEmailBody(rawBody: {
  contentType: string;
  content: string;
}): ParsedEmailBody {
  const content = rawBody.content ?? "";
  if (!content) {
    return { body_text: "", body_html: null };
  }

  const ct = (rawBody.contentType ?? "").toLowerCase().trim();
  if (ct === "html") {
    return {
      body_text: htmlToPlainText(content),
      body_html: content,
    };
  }
  // Default: treat as plain text. This matches Graph's "text" contentType
  // and any unexpected value (we'd rather pass through than drop data).
  return { body_text: content, body_html: null };
}

export default parseEmailBody;
