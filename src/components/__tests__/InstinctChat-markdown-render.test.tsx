/**
 * @jest-environment jsdom
 *
 * DOM-level regression tests for assistant message rendering.
 *
 * These tests are the layer that was missing. The prior e2e tests
 * asserted the API payload shape was correct, but never asserted
 * what a user actually SEES in the browser. As a result, a page-facts
 * answer that produced `[Knowledge Base](/knowledge)` in the payload
 * was rendered as literal text instead of a clickable <a>. That ships
 * as a broken dashboard even when every API test passes.
 *
 * We test `renderMessageContent` directly — the pure function that
 * turns a markdown-flavored assistant message into React nodes — so
 * the tests are stable and fast, and catch the bug the screenshot
 * showed (`[/knowledge](/knowledge)` rendered as literal text).
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { renderMessageContent, isSafeHref } from "@/lib/assistant/render-markdown";
import { formatPageFactsAnswer, PAGE_FACTS } from "@/lib/assistant/page-facts";

function Wrap({ content }: { content: string }) {
  return <div data-testid="wrap">{renderMessageContent(content)}</div>;
}

describe("renderMessageContent — the bug the API tests missed", () => {
  it("renders [Knowledge Base](/knowledge) as a clickable <a href='/knowledge'>", () => {
    render(<Wrap content="Open it: [Knowledge Base](/knowledge)" />);
    const anchor = screen.getByTestId("msg-link-/knowledge") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/knowledge");
    expect(anchor.textContent).toBe("Knowledge Base");
  });

  it("does NOT leave literal [text](url) markdown in the rendered DOM", () => {
    render(<Wrap content="Open it: [Calendar](/calendar) · Related: [Goals](/goals)" />);
    const wrap = screen.getByTestId("wrap");
    expect(wrap.textContent).not.toMatch(/\[Calendar\]\(\/calendar\)/);
    expect(wrap.textContent).not.toMatch(/\[Goals\]\(\/goals\)/);
    expect(screen.getByTestId("msg-link-/calendar")).toBeInTheDocument();
    expect(screen.getByTestId("msg-link-/goals")).toBeInTheDocument();
  });

  it("renders **bold** as <strong>", () => {
    render(<Wrap content="**Calendar** — your schedule." />);
    const strong = screen.getByText("Calendar", { selector: "strong" });
    expect(strong.tagName).toBe("STRONG");
  });

  it("refuses javascript: hrefs — renders the raw text instead, no <a> emitted", () => {
    render(<Wrap content="Click [me](javascript:alert(1)) now" />);
    expect(screen.queryByTestId(/^msg-link-javascript/)).toBeNull();
    expect(screen.getByTestId("wrap").textContent).toMatch(
      /\[me\]\(javascript:alert\(1\)\) now/,
    );
  });

  it.each([
    ["data:text/html,<script>x</script>", false],
    ["mailto:x@y.com", false],
    ["ftp://example.com", false],
    ["/calendar", true],
    ["/sites/site_a3106cfe-ee77-4641-aec5-ce9f1d7a9ce1", true],
    ["https://example.com", true],
    ["http://example.com", true],
    ["//protocol-relative.com", false],
  ])("isSafeHref(%p) === %p", (href, expected) => {
    expect(isSafeHref(href as string)).toBe(expected);
  });

  it("external http(s) links open in a new tab with noopener", () => {
    render(<Wrap content="See [example](https://example.com) for info." />);
    const a = screen.getByTestId("msg-link-https://example.com") as HTMLAnchorElement;
    expect(a.target).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders a page-facts answer end-to-end with every embedded link clickable", () => {
    const knowledge = PAGE_FACTS["knowledge"];
    render(<Wrap content={formatPageFactsAnswer(knowledge)} />);
    // Must include the Open-it link AND every related-pages link.
    expect(screen.getByTestId(`msg-link-${knowledge.route}`)).toBeInTheDocument();
    for (const relatedDomain of knowledge.related_pages) {
      const related = PAGE_FACTS[relatedDomain];
      if (!related) continue;
      expect(screen.getByTestId(`msg-link-${related.route}`)).toBeInTheDocument();
    }
    // And the rendered text must not leak any raw markdown syntax.
    expect(screen.getByTestId("wrap").textContent).not.toMatch(/\]\(\//);
  });
});

describe("page-facts formatter — label quality", () => {
  it("formatter uses the page TITLE as the link label, not the raw /route", () => {
    // Regression: previously emitted "Open it: [/knowledge](/knowledge)"
    // — an ugly, bare-route label. The fix uses the title.
    const knowledge = PAGE_FACTS["knowledge"];
    const out = formatPageFactsAnswer(knowledge);
    expect(out).toMatch(/Open it: \[Knowledge Base\]\(\/knowledge\)/);
    expect(out).not.toMatch(/Open it: \[\/knowledge\]\(\/knowledge\)/);
  });

  it.each(Object.values(PAGE_FACTS).map((f) => [f.domain, f.title, f.route]))(
    "page-facts for '%s' embeds the link [%s](%s)",
    (_domain, title, route) => {
      const fact = Object.values(PAGE_FACTS).find(
        (f) => f.route === route && f.title === title,
      )!;
      const out = formatPageFactsAnswer(fact);
      expect(out).toContain(`[${title}](${route})`);
    },
  );
});
