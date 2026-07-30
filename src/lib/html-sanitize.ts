/**
 * Parser-based HTML sanitization helpers.
 *
 * Built to replace ad-hoc regex-based stripping (`.replace(/<script>/g, "")`,
 * `.replace(/<[^>]+>/g, "")`, etc.) which is defeated by mutation-style
 * attacks like `<scr<script>ipt>`: the substring left after the regex
 * replacement reconstructs the dangerous tag.
 *
 * Two surfaces:
 *
 *   sanitizeHtml(html)   — returns sanitized HTML safe to render. Backed by
 *                          DOMPurify (isomorphic-dompurify, server+client).
 *
 *   htmlToText(html)     — returns plain text only (no markup). Backed by
 *                          cheerio in Node and the platform DOMParser when
 *                          a real `document` is present (jsdom in tests, the
 *                          browser at runtime).
 *
 * Why both:
 *   - Email reader / signature preview RENDERS the result → use
 *     sanitizeHtml so animated logos and link styling survive.
 *   - Calendar-outcome / meeting-insights / search excerpts etc. only need
 *     the raw text → use htmlToText so the pipeline never decides what HTML
 *     to render.
 *
 * Both functions are single-pass (parser-driven), so the
 * `<scr<script>ipt>` mutation attack class is blocked: the parser sees
 * an open `<scr` token, not a string we're about to scrub.
 */

/* DOMPurify is loaded lazily via the helpers below so importing this
   module never pulls jsdom + ESM-only sub-deps into a Jest test that
   only needs `htmlToText` (cheerio path). The cost is one require()
   per call site once warm. */
type DOMPurifyLike = {
  sanitize: (
    dirty: string,
    cfg?: Record<string, unknown>,
  ) => string;
};

let cachedDomPurify: DOMPurifyLike | null = null;

function loadDomPurify(): DOMPurifyLike {
  if (cachedDomPurify) return cachedDomPurify;
   
  const mod = require("isomorphic-dompurify") as
    | { default?: DOMPurifyLike }
    | DOMPurifyLike;
  cachedDomPurify =
    "sanitize" in mod
      ? (mod as DOMPurifyLike)
      : (mod as { default: DOMPurifyLike }).default;
  return cachedDomPurify;
}

/* ------------------------------------------------------------------ */
/* sanitizeHtml — DOMPurify wrapper                                    */
/* ------------------------------------------------------------------ */

/**
 * Conservative tag/attribute allow-list for email bodies and signatures.
 *
 * Excludes: script, style, iframe, object, embed, form, input, button,
 * meta, link, base, frame, frameset, applet, audio, video.
 *
 * Includes: structural + inline + image + table + list elements that
 * Outlook / Gmail emit in real signatures.
 */
const EMAIL_ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const EMAIL_ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "valign",
  "cellpadding",
  "cellspacing",
  "border",
  "colspan",
  "rowspan",
  "style", // inline styles allowed; DOMPurify still sanitizes url(javascript:) etc.
  "class",
  "target",
  "rel",
  /* Email signatures store inline image refs by Content-ID. After
     resolveCidImages() replaces these with data: URIs we want them to
     survive sanitization, so allow the attribute as-is. */
  "data-cid",
];

export interface SanitizeHtmlOptions {
  /** Override the default allow-list of tags. */
  allowedTags?: string[];
  /** Override the default allow-list of attributes. */
  allowedAttr?: string[];
  /** Drop ALL tags and return only text — equivalent to htmlToText. */
  textOnly?: boolean;
}

/**
 * Run untrusted HTML through DOMPurify and return a safe HTML string.
 *
 * Uses an allow-list. javascript: / vbscript: URI schemes are stripped
 * by DOMPurify by default. data: URIs are kept (we use them for inline
 * Content-ID image rendering in email signatures) but only on tags that
 * can't execute (img, video poster) — DOMPurify enforces that internally.
 */
export function sanitizeHtml(
  html: string,
  opts: SanitizeHtmlOptions = {},
): string {
  if (!html) return "";
  if (opts.textOnly) return htmlToText(html);
  const DOMPurify = loadDomPurify();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: opts.allowedTags ?? EMAIL_ALLOWED_TAGS,
    ALLOWED_ATTR: opts.allowedAttr ?? EMAIL_ALLOWED_ATTR,
    /* FORBID_TAGS / FORBID_ATTR explicit so even if a future contributor
       widens the allow-list, these can never come back. */
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
    /* keepContent removes the tag but keeps its child text; we want this
       so users still see the message body even if the wrapping tag was
       disallowed. */
    KEEP_CONTENT: true,
    /* Block the mutation-XSS attack surface — strip <noscript>, MathML,
       SVG foreign content. Email bodies don't need them. */
    USE_PROFILES: { html: true },
  });
}

/**
 * Sanitize with an explicit tag/attribute allow-list and no `USE_PROFILES`
 * override. `sanitizeHtml` forces the DOMPurify html profile, which drops some
 * safe attributes (e.g. `target`); callers that render their own trusted markup
 * and need those attributes use this. Same lazily-loaded DOMPurify (so importing
 * this module never pulls jsdom's ESM sub-deps into build-time collection).
 */
export function sanitizeHtmlStrict(
  html: string,
  allowedTags: string[],
  allowedAttr: string[],
): string {
  if (!html) return "";
  const DOMPurify = loadDomPurify();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttr,
  });
}

/* ------------------------------------------------------------------ */
/* htmlToText — parser-based plain-text extraction                     */
/* ------------------------------------------------------------------ */

/**
 * Convert HTML to plain text using a real parser.
 *
 * On the server: uses cheerio (already in the dep tree). On the client
 * or in jsdom: uses platform DOMParser. Either way, the input is parsed
 * into a tree once and we read .textContent — never regex.
 *
 * Block-level tags emit a newline so signatures / paragraphs survive.
 * Multiple consecutive whitespace + blank lines are collapsed at the
 * end so callers get a tidy result without further post-processing.
 */
export function htmlToText(html: string): string {
  if (!html) return "";

  /* Browser / jsdom: use the platform DOMParser. Node ≥ 22 also has it,
     but on older Node we fall through to cheerio. */
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { DOMParser?: unknown }).DOMParser === "function"
  ) {
    try {
      const DOMParserCtor = (globalThis as unknown as {
        DOMParser: typeof DOMParser;
      }).DOMParser;
      const doc = new DOMParserCtor().parseFromString(
        wrapForParse(html),
        "text/html",
      );
      /* Strip <script> + <style> children: textContent would otherwise
         include their literal contents (e.g. CSS rules). */
      doc
        .querySelectorAll("script, style, noscript")
        .forEach((el) => el.remove());
      /* Replace <br> with newlines, block-level closers with newlines.
         We do this on the parsed tree, not via regex on the source. */
      doc.querySelectorAll("br").forEach((br) => {
        br.replaceWith(doc.createTextNode("\n"));
      });
      const blockTags = [
        "p",
        "div",
        "li",
        "tr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
      ];
      blockTags.forEach((tag) => {
        doc.querySelectorAll(tag).forEach((el) => {
          el.appendChild(doc.createTextNode("\n"));
        });
      });
      const text = doc.body?.textContent ?? "";
      return collapseWhitespace(text);
    } catch {
      /* Fall through to cheerio path. */
    }
  }

  /* Server (Node) — cheerio. We delegate dynamic import so the dependency
     stays out of client bundles when this helper is reached only from
     server code. */
  try {
     
    const cheerio = require("cheerio") as typeof import("cheerio");
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    $("br").replaceWith("\n");
    $("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre").each(
      (_, el) => {
        $(el).append("\n");
      },
    );
    const text = $.root().text();
    return collapseWhitespace(text);
  } catch {
    /* Last-resort fallback: return the input minus the obvious tag
       brackets via DOMPurify's textContent extraction. Still parser-
       based — never the regex pattern that CodeQL flagged. */
    const DOMPurify = loadDomPurify();
    return collapseWhitespace(
      DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }),
    );
  }
}

function wrapForParse(html: string): string {
  /* If the caller passed a fragment (no <html>/<body>), DOMParser still
     handles it — it auto-injects html/body. We wrap defensively to make
     querySelectorAll on doc.body deterministic across browsers. */
  return `<!doctype html><html><body>${html}</body></html>`;
}

function collapseWhitespace(text: string): string {
  return text
    /* Normalize newlines, then collapse runs of whitespace within a line
       and runs of blank lines. */
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
