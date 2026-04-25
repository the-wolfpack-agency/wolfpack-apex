/**
 * Cognito email body extraction — pure helper shared by every Cognito
 * Forms parser (coordinator + instructor today, future Cognito surveys
 * tomorrow).
 *
 * Why HTML, not plain text?
 *   The text/plain body Cognito sends has zero delimiters between
 *   label and value (`Date4/13/2026ClassBA101Class LocationWestlake...`),
 *   so any regex-based parser must hard-code a label vocabulary and
 *   becomes brittle as soon as a new question is added. The text/html
 *   body, by contrast, is a tidy `<th>label</th><td>value</td>` table
 *   under `<h2 class="header-2">section heading</h2>` blocks. The HTML
 *   structure has been stable across every Cognito Forms email we've
 *   inspected.
 *
 * Pure function. No I/O. No side effects. Tested against fixtures.
 */
import * as cheerio from "cheerio";

/* ------------------------------------------------------------------ */
/* Multipart extraction — minimal RFC 2046 walker                      */
/* ------------------------------------------------------------------ */

export interface ExtractedParts {
  /** Raw text/html body, decoded if quoted-printable. */
  html: string | null;
  /** Raw text/plain body, decoded if quoted-printable. */
  text: string | null;
  /** Subject line, RFC 2047 decoded. */
  subject: string | null;
  /** From header value (raw). */
  from: string | null;
  /** Date header value (raw). */
  date: string | null;
  /** Message-ID stripped of angle brackets. */
  message_id: string | null;
}

/**
 * Decode a quoted-printable payload to UTF-8 text.
 *
 * Handles: =XX hex escapes, soft line-breaks (=\r?\n), and assumes the
 * payload's charset is utf-8 (Cognito's only output).
 */
export function decodeQuotedPrintable(input: string): string {
  // Soft line breaks first — `=\r\n` or `=\n` are continuation markers.
  const noSoftBreaks = input.replace(/=\r?\n/g, "");
  // Now =XX hex escapes. Collect all bytes, then decode as UTF-8.
  const out: number[] = [];
  let i = 0;
  while (i < noSoftBreaks.length) {
    const ch = noSoftBreaks[i];
    if (ch === "=" && i + 2 < noSoftBreaks.length) {
      const hex = noSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    out.push(ch.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(out).toString("utf8");
}

/** Decode an RFC 2047 encoded-word in a header value (e.g. `=?utf-8?Q?...?=`). */
export function decodeHeaderWord(value: string): string {
  return value.replace(
    /=\?([\w-]+)\?([QqBb])\?([^?]+)\?=/g,
    (_, charsetRaw: string, encRaw: string, body: string) => {
      const enc = encRaw.toUpperCase();
      const charset = charsetRaw.toLowerCase();
      try {
        if (enc === "Q") {
          // RFC 2047 Q encoding: `_` -> space, =XX hex escape.
          const replaced = body.replace(/_/g, " ");
          // Use the same byte-collecting decoder so utf-8 multibyte
          // sequences (e.g. =E2=80=99) reassemble correctly.
          const bytes: number[] = [];
          let i = 0;
          while (i < replaced.length) {
            const ch = replaced[i];
            if (ch === "=" && i + 2 < replaced.length) {
              const hex = replaced.slice(i + 1, i + 3);
              if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 3;
                continue;
              }
            }
            bytes.push(ch.charCodeAt(0));
            i += 1;
          }
          return Buffer.from(bytes).toString(
            charset === "utf-8" ? "utf8" : "binary",
          );
        }
        if (enc === "B") {
          return Buffer.from(body, "base64").toString(
            charset === "utf-8" ? "utf8" : "binary",
          );
        }
      } catch {
        return body;
      }
      return body;
    },
  );
}

/**
 * Find a header field by name (case-insensitive) in the eml header block.
 * Handles header folding (continuation lines start with whitespace).
 */
function readHeader(headerBlock: string, name: string): string | null {
  const lines = headerBlock.split(/\r?\n/);
  const target = name.toLowerCase();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).toLowerCase() === target) {
      let value = line.slice(colon + 1).trim();
      // Fold continuation lines (RFC 5322 §2.2.3).
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
        i += 1;
        value += " " + lines[i].trim();
      }
      return value;
    }
    i += 1;
  }
  return null;
}

/**
 * Pull `Content-Type` boundary= attribute out of a Content-Type header.
 */
function findBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i);
  return m ? m[1] : null;
}

/**
 * Extract the text/html and text/plain parts (plus key headers) from a
 * raw .eml file. Pure: takes bytes, returns parts.
 *
 * Cognito always sends `multipart/alternative` with both parts, so this
 * walker only needs to handle that single structure. We return whatever
 * we find; callers decide which part they want.
 */
export function extractEmlParts(raw: Buffer | string): ExtractedParts {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;

  // Header / body split — first blank line.
  const split = text.indexOf("\r\n\r\n");
  const headerEnd = split >= 0 ? split : text.indexOf("\n\n");
  if (headerEnd < 0) {
    return {
      html: null,
      text: null,
      subject: null,
      from: null,
      date: null,
      message_id: null,
    };
  }
  const headerBlock = text.slice(0, headerEnd);
  // Skip the blank-line marker (2 or 4 chars).
  const bodyStart = text.startsWith("\r\n\r\n", headerEnd)
    ? headerEnd + 4
    : headerEnd + 2;
  const body = text.slice(bodyStart);

  const subjectRaw = readHeader(headerBlock, "Subject");
  const fromRaw = readHeader(headerBlock, "From");
  const dateRaw = readHeader(headerBlock, "Date");
  const msgIdRaw = readHeader(headerBlock, "Message-Id");
  const contentType = readHeader(headerBlock, "Content-Type");

  const subject = subjectRaw ? decodeHeaderWord(subjectRaw) : null;
  const from = fromRaw ? decodeHeaderWord(fromRaw) : null;
  const date = dateRaw;
  const message_id = msgIdRaw
    ? msgIdRaw.replace(/^<|>$/g, "").trim() || null
    : null;

  // If not multipart, treat whole body as a single part using the top-level CT.
  const boundary = contentType ? findBoundary(contentType) : null;
  if (!boundary) {
    // Decode body once if quoted-printable.
    const cte = readHeader(headerBlock, "Content-Transfer-Encoding") ?? "";
    const decoded =
      cte.toLowerCase() === "quoted-printable"
        ? decodeQuotedPrintable(body)
        : body;
    if (
      contentType &&
      contentType.toLowerCase().includes("text/html")
    ) {
      return { html: decoded, text: null, subject, from, date, message_id };
    }
    return { html: null, text: decoded, subject, from, date, message_id };
  }

  // Walk the multipart parts.
  const parts = splitMultipart(body, boundary);

  let htmlOut: string | null = null;
  let textOut: string | null = null;
  for (const part of parts) {
    const inner = readPart(part);
    if (!inner) continue;
    if (inner.contentType.toLowerCase().includes("text/html") && !htmlOut) {
      htmlOut = inner.body;
    } else if (
      inner.contentType.toLowerCase().includes("text/plain") &&
      !textOut
    ) {
      textOut = inner.body;
    }
  }

  return {
    html: htmlOut,
    text: textOut,
    subject,
    from,
    date,
    message_id,
  };
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const closing = delim + "--";
  // Strip preamble + epilogue.
  const idx = body.indexOf(delim);
  if (idx < 0) return [];
  const after = body.slice(idx);
  // Cut at closing boundary.
  const closeIdx = after.indexOf(closing);
  const trimmed = closeIdx >= 0 ? after.slice(0, closeIdx) : after;
  // Split on the delimiter; first chunk is empty (boundary at start).
  return trimmed
    .split(delim)
    .map((p) => p.replace(/^\r?\n/, "").replace(/\r?\n$/, ""))
    .filter((p) => p.length > 0);
}

function readPart(
  part: string,
): { contentType: string; body: string } | null {
  // Headers terminate at the first blank line within the part.
  const split = part.indexOf("\r\n\r\n");
  const end = split >= 0 ? split : part.indexOf("\n\n");
  if (end < 0) return null;
  const headerBlock = part.slice(0, end);
  const bodyStart = part.startsWith("\r\n\r\n", end) ? end + 4 : end + 2;
  const rawBody = part.slice(bodyStart);

  const contentType = readHeader(headerBlock, "Content-Type") ?? "text/plain";
  const cte =
    readHeader(headerBlock, "Content-Transfer-Encoding")?.toLowerCase() ??
    "7bit";

  let decoded: string;
  if (cte === "quoted-printable") decoded = decodeQuotedPrintable(rawBody);
  else if (cte === "base64") {
    decoded = Buffer.from(rawBody.replace(/\s+/g, ""), "base64").toString(
      "utf8",
    );
  } else decoded = rawBody;

  return { contentType, body: decoded };
}

/* ------------------------------------------------------------------ */
/* Cognito field extraction — sections + label/value table rows        */
/* ------------------------------------------------------------------ */

/**
 * Parsed Cognito form: section headings → ordered list of {label, value}.
 *
 * Order is preserved (it matters for some downstream renderers) and the
 * shape is stable across coordinator + instructor + future Cognito forms
 * because they all share the same email template.
 */
export interface CognitoFormFields {
  /** Form title from the "==Section==" heading (e.g. "Coordinator Class Report"). */
  formTitle: string | null;
  /** Sections in document order. The first section is "Entry Details". */
  sections: CognitoSection[];
  /**
   * Flat lookup across all sections — last-wins on duplicate labels (no
   * Cognito form we've seen has duplicate labels but we de-duplicate
   * defensively). Useful for callers that only need a value by label.
   */
  byLabel: Record<string, string>;
}

export interface CognitoSection {
  heading: string;
  fields: { label: string; value: string }[];
}

/**
 * Parse a Cognito Forms HTML body into structured sections.
 *
 * The Cognito email template:
 *   <h2 class="header-2">SectionHeading</h2>
 *   <table class="real-table-container">
 *     <tr><th>Label</th><td>Value</td></tr>
 *     ...
 *   </table>
 *
 * Multiple section/table pairs may appear. Tables without `<th>` cells
 * (e.g. the header logo) are skipped. We strip whitespace and decode
 * HTML entities via cheerio's `.text()`.
 */
export function parseCognitoHtml(html: string): CognitoFormFields {
  const $ = cheerio.load(html);

  // Form title: the body has an <h2> right under the logo with no
  // .header-2 class but with text matching the report name. The Entry
  // Details title is .header-2. The form title appears in <h1
  // class="header-1">Porsche Academy US</h1> followed by a sibling <h2>
  // with the form name. Easiest: pick the <h2> that is NOT a section
  // heading and lives outside the data tables.
  const formTitle = ($("h2")
    .filter((_, el) => !$(el).hasClass("header-2"))
    .first()
    .text() || null) as string | null;
  const formTitleClean = formTitle ? collapseWs(formTitle) : null;

  const sections: CognitoSection[] = [];

  // Document-order walk. The Cognito email template has one
  // `<h2 class="header-2">` for the FIRST section ("Entry Details") and
  // bare inline-styled `<h2>` headings for later sections (Hotel
  // Experience, Dinner Outing, etc.) — both kinds need to be treated as
  // section breakers. We don't try to filter by class; instead we
  // detect heading-vs-form-title by structural position: any <h2>
  // encountered AFTER the form-title h2 is a section heading. The
  // form-title h2 is always the first one in the body, lives outside
  // any data table, and matches text like "Coordinator Class Report" or
  // "Instructor Class Report".
  let currentHeading: string | null = null;
  let currentFields: { label: string; value: string }[] = [];
  let seenFormTitleH2 = false;

  function flush() {
    if (currentHeading && currentFields.length > 0) {
      sections.push({
        heading: currentHeading,
        fields: currentFields,
      });
    }
    currentHeading = null;
    currentFields = [];
  }

  // Track the form-title text so we can skip it as a section heading.
  // (We picked `formTitle` above with a separate query; the value is
  // stable.)
  const formTitleText = formTitleClean ?? "";

  // We walk every <h2> and every <tr>, in document order. A <tr> is the
  // unit of "label/value pair"; we also capture any <h2> that crosses a
  // section boundary.
  $("h2, tr").each((_, el) => {
    const $el = $(el);
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "h2") {
      const text = collapseWs($el.text());
      // The form title is the first <h2> we see and matches the title
      // we extracted above (or contains "Class Report" — the safety
      // net for templates that drift).
      if (
        !seenFormTitleH2 &&
        (text === formTitleText || /Class Report/i.test(text))
      ) {
        seenFormTitleH2 = true;
        return;
      }
      // Otherwise this h2 starts a new section.
      flush();
      currentHeading = text;
      return;
    }
    // <tr>: pick up <th>+<td> pairs. The Cognito template puts only
    // label/value rows in the data tables, so we don't need to
    // disambiguate "header row" vs "data row".
    const th = $el.find("> th").first();
    const td = $el.find("> td").first();
    if (th.length === 0 || td.length === 0) return;
    const label = collapseWs(th.text());
    const value = collapseWs(td.text());
    if (!label) return;
    currentFields.push({ label, value });
  });
  flush();

  const byLabel: Record<string, string> = {};
  for (const section of sections) {
    for (const field of section.fields) {
      byLabel[field.label] = field.value;
    }
  }

  return { formTitle: formTitleClean, sections, byLabel };
}

/** Collapse \s+ to single space and trim. */
export function collapseWs(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* ClassKey + parsed-class helpers — used by coordinator + instructor  */
/* ------------------------------------------------------------------ */

/**
 * Normalize a Cognito date string (`4/13/2026`, `04/13/2026`,
 * `2026-04-13`) to ISO `YYYY-MM-DD`. Returns null on unparseable input.
 *
 * Cognito's emails always send `M/D/YYYY` from the US backend — but we
 * accept the alternate forms so a future format flip doesn't break us
 * silently.
 */
export function normalizeClassDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // ISO already?
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // M/D/YYYY or MM/DD/YYYY
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Title-case a free-form location string. Collapses internal whitespace
 * and strips trailing punctuation. Matches the contract on
 * `ParsedClass.location`.
 */
export function normalizeLocation(raw: string): string {
  const collapsed = collapseWs(raw).replace(/[.,;]+$/, "");
  // Title-case word-by-word but preserve all-caps tokens (e.g. "USA").
  return collapsed
    .split(" ")
    .map((w) => {
      if (!w) return w;
      // Title-case every word — collapses "WESTLAKE", "Los Angeles", and
      // "los angeles" all to the same canonical form. We do NOT try to
      // preserve known acronyms (USA, NYC) here because Cognito sends
      // city/dealership names which never collide with acronym tokens.
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Build the canonical class_key the contract requires. */
export function buildClassKey(
  course: string,
  classDateIso: string,
  location: string,
): string {
  return `${course}|${classDateIso}|${location}`;
}
