import type { ReactNode } from "react";
import { CodeBlock } from "@/components/chat/CodeBlock";

/**
 * Minimal inline markdown renderer for assistant messages.
 *
 * Scope, intentionally: fenced ```code``` blocks, inline `code`,
 * **bold**, [label](url) links (both absolute https:// and in-app
 * /route), and preserve whitespace as-is. Keeps compatibility with
 * the page-facts formatter which emits bolded headings + markdown
 * links pointing at in-app routes like /goals.
 *
 * Parsing order — important: fenced ``` blocks are extracted FIRST,
 * then inline `code` spans, then **bold** + [label](url). The earlier
 * passes carve the content into text/code segments so the later
 * bold/link regex only ever sees prose. That keeps code containing
 * `**` or `[](...)` from being mis-parsed as markdown.
 *
 * Security: in-app routes must start with `/` and contain only
 * route-safe characters. External links must be http(s). Anything else
 * (javascript:, data:, mailto:, custom schemes) is rendered as plain
 * text — no XSS vectors through the renderer. Code is rendered as
 * text nodes, never as HTML.
 */

const MARKDOWN_TOKEN = /(\*\*[^*\n]+\*\*|\[[^\]]+?\]\([^)]+?\))/g;
const BOLD_RE = /^\*\*([^*\n]+)\*\*$/;
const LINK_RE = /^\[([^\]]+?)\]\(([^)]+?)\)$/;

// Fenced code: ```optional-lang\n...body...\n```
// Capture group 1 = language tag (may be empty), group 2 = body.
// The /s flag lets `.` match newlines. We require the closing fence
// to land on a new line, matching the standard CommonMark shape.
const FENCED_CODE_RE = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g;

// Inline code: single backticks. Disallow newlines inside so a
// stray backtick in prose doesn't swallow the rest of the message.
const INLINE_CODE_RE = /`([^`\n]+)`/g;

export function isSafeHref(href: string): boolean {
  // Protocol-relative URLs (//host/path) resolve against the current
  // page origin's protocol but the host is attacker-controlled. Reject.
  if (href.startsWith("//")) return false;
  if (href.startsWith("/")) {
    return /^\/[A-Za-z0-9/_#?&=.~:+-]*$/.test(href);
  }
  if (href.startsWith("https://") || href.startsWith("http://")) {
    return true;
  }
  return false;
}

/**
 * Render a prose-only segment — no fenced or inline code may appear
 * inside the input. This is the leaf parser that handles **bold** and
 * [label](url). It is intentionally the same logic the renderer used
 * before fenced-code support was added, so existing behavior is
 * preserved byte-for-byte for messages without code.
 */
function renderProseSegment(content: string, keyPrefix: string): ReactNode[] {
  const parts = content.split(MARKDOWN_TOKEN);
  return parts.map((part, i) => {
    if (!part) return null;
    const key = `${keyPrefix}-${i}`;
    const bold = part.match(BOLD_RE);
    if (bold) {
      return (
        <strong key={key} className="font-semibold">
          {bold[1]}
        </strong>
      );
    }
    const link = part.match(LINK_RE);
    if (link) {
      const [, label, href] = link;
      if (!isSafeHref(href)) {
        return <span key={key}>{part}</span>;
      }
      const isExternal = href.startsWith("http");
      return (
        <a
          key={key}
          href={href}
          className="underline"
          style={{ color: "var(--wp-gold, #eab308)", textDecoration: "underline" }}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          data-testid={`msg-link-${href}`}
        >
          {label}
        </a>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

/**
 * Render a string segment that may contain inline `code` spans. Splits
 * on backtick-delimited runs, renders each as <code>, and recurses
 * into renderProseSegment for the remaining prose.
 */
function renderInlineCodeAndProse(
  content: string,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;
  // Reset lastIndex; the regex is a module-level /g, so previous
  // iterations on other inputs could otherwise resume mid-string.
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(content)) !== null) {
    if (m.index > lastIndex) {
      const prose = content.slice(lastIndex, m.index);
      out.push(
        ...renderProseSegment(prose, `${keyPrefix}-p${matchIndex}`),
      );
    }
    out.push(
      <code
        key={`${keyPrefix}-c${matchIndex}`}
        data-testid="assistant-inline-code"
        style={{
          background: "var(--wp-dark-surface2, #222)",
          color: "var(--wp-text, #e5e7eb)",
          padding: "1px 5px",
          borderRadius: "3px",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: "0.92em",
        }}
      >
        {m[1]}
      </code>,
    );
    lastIndex = m.index + m[0].length;
    matchIndex += 1;
  }
  if (lastIndex < content.length) {
    out.push(
      ...renderProseSegment(
        content.slice(lastIndex),
        `${keyPrefix}-p${matchIndex}`,
      ),
    );
  }
  return out;
}

export function renderMessageContent(content: string): ReactNode {
  if (!content) return null;

  // Pass 1: carve out fenced code blocks. Everything outside a fence
  // is forwarded to the inline-code + prose pipeline; everything
  // inside a fence becomes a <CodeBlock /> rendered verbatim.
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let blockIndex = 0;
  FENCED_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_CODE_RE.exec(content)) !== null) {
    if (m.index > lastIndex) {
      const before = content.slice(lastIndex, m.index);
      out.push(...renderInlineCodeAndProse(before, `pre${blockIndex}`));
    }
    const language = m[1] || "";
    // CommonMark: the newline before the closing fence is a fence
    // delimiter, not part of the code body. Strip exactly one trailing
    // newline so `body.textContent` matches what the user typed.
    const body = m[2].endsWith("\n") ? m[2].slice(0, -1) : m[2];
    out.push(
      <CodeBlock
        key={`block-${blockIndex}`}
        language={language}
        code={body}
      />,
    );
    lastIndex = m.index + m[0].length;
    blockIndex += 1;
  }
  if (lastIndex < content.length) {
    out.push(
      ...renderInlineCodeAndProse(
        content.slice(lastIndex),
        `post${blockIndex}`,
      ),
    );
  }

  // Preserve the existing return shape — when there are no code
  // fences AND no inline code, the output is the same flat array of
  // ReactNodes the original parser produced, so snapshot-style tests
  // and DOM-position assertions stay stable.
  return out;
}
