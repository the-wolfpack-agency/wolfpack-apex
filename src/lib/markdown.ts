/**
 * markdown.ts: a small, dependency-light Markdown -> sanitized HTML renderer.
 *
 * Shared by the Engineering wiki (/engineering) and available to any other
 * surface that stores plain Markdown. Output is ALWAYS run through DOMPurify, so
 * page content (which an operator can author) can never inject script/style/
 * event-handler HTML. Supports the subset the wiki needs: headings, bold/italic,
 * inline code, fenced code blocks, ordered/unordered lists, tables, blockquotes,
 * links, and paragraphs. Not a full CommonMark parser; deliberately simple.
 */

import { sanitizeHtmlStrict } from "@/lib/html-sanitize";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline formatting: code, bold, italic, links. Runs on already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\b_([^_]+)_\b/g, "<em>$1</em>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // [label](https://…) -> anchor (http/https/relative only).
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_m, label, href) => {
      const ext = /^https?:/.test(href);
      return `<a href="${href}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    });
}

/** Render a Markdown string to sanitized HTML. */
export function renderMarkdown(md: string): string {
  if (!md || typeof md !== "string") return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushList = (buf: string[], ordered: boolean) => {
    if (!buf.length) return;
    out.push(`<${ordered ? "ol" : "ul"}>${buf.map((b) => `<li>${inline(esc(b))}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      // The page title is the h1, so body headings start at h2: `##` -> h2, `###` -> h3.
      const level = Math.min(Math.max(h[1].length, 2), 5);
      out.push(`<h${level}>${inline(esc(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(esc(quote.join(" ")))}</blockquote>`);
      continue;
    }

    // Table (pipe rows with a separator line).
    if (/^\|(.+)\|\s*$/.test(line) && i + 1 < lines.length && /^\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
      const cells = (row: string) => row.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\|(.+)\|\s*$/.test(lines[i])) bodyRows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join("")}</tr></thead>` +
          `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ""));
      flushList(buf, false);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ""));
      flushList(buf, true);
      continue;
    }

    // Blank line.
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph (consume until a blank line or a block starter).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|[-*]\s|\d+\.\s|>\s?|```)/.test(lines[i]) &&
      !/^\|(.+)\|\s*$/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
  }

  // Reuse the shared, lazily-loaded sanitizer (html-sanitize.ts) rather than
  // importing DOMPurify at module top: a top-level import pulls jsdom's ESM-only
  // sub-deps into build-time page-data collection and fails the build.
  return sanitizeHtmlStrict(
    out.join("\n"),
    ["h1", "h2", "h3", "h4", "h5", "p", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "br"],
    ["href", "target", "rel"],
  );
}
