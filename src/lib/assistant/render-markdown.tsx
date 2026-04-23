import type { ReactNode } from "react";

/**
 * Minimal inline markdown renderer for assistant messages.
 *
 * Scope, intentionally: **bold**, [label](url) links (both absolute
 * https:// and in-app /route), and preserve whitespace as-is. Keeps
 * compatibility with the page-facts formatter which emits bolded
 * headings + markdown links pointing at in-app routes like /goals.
 *
 * Security: in-app routes must start with `/` and contain only
 * route-safe characters. External links must be http(s). Anything else
 * (javascript:, data:, mailto:, custom schemes) is rendered as plain
 * text — no XSS vectors through the renderer.
 */

const MARKDOWN_TOKEN = /(\*\*[^*\n]+\*\*|\[[^\]]+?\]\([^)]+?\))/g;
const BOLD_RE = /^\*\*([^*\n]+)\*\*$/;
const LINK_RE = /^\[([^\]]+?)\]\(([^)]+?)\)$/;

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

export function renderMessageContent(content: string): ReactNode {
  if (!content) return null;
  const parts = content.split(MARKDOWN_TOKEN);
  return parts.map((part, i) => {
    if (!part) return null;
    const bold = part.match(BOLD_RE);
    if (bold) {
      return (
        <strong key={i} className="font-semibold">
          {bold[1]}
        </strong>
      );
    }
    const link = part.match(LINK_RE);
    if (link) {
      const [, label, href] = link;
      if (!isSafeHref(href)) {
        return <span key={i}>{part}</span>;
      }
      const isExternal = href.startsWith("http");
      return (
        <a
          key={i}
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
    return <span key={i}>{part}</span>;
  });
}
