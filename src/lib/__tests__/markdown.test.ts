/**
 * @jest-environment node
 *
 * Markdown renderer: the subset the wiki uses, plus the security guarantee that
 * page content can never inject script/event-handler HTML (DOMPurify).
 */

import { renderMarkdown } from "@/lib/markdown";

describe("renderMarkdown", () => {
  it("renders headings, bold, italic, and inline code", () => {
    const html = renderMarkdown("## Title\n\nSome **bold** and _em_ and `code`.");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders fenced code blocks with escaped content", () => {
    const html = renderMarkdown("```\nconst x = 1 < 2;\n```");
    expect(html).toContain("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });

  it("renders links: external opens in a new tab, relative does not", () => {
    const ext = renderMarkdown("[site](https://x.test/a)");
    expect(ext).toContain('<a href="https://x.test/a" target="_blank" rel="noopener noreferrer">site</a>');
    const rel = renderMarkdown("[here](/products)");
    expect(rel).toContain('<a href="/products">here</a>');
    expect(rel).not.toContain("target=");
  });

  it("wraps every table in a scroll box", () => {
    /* Without it the browser squeezes the columns to fit the content pane: a
       one-word status cell like "planned" stacked one letter per line and the
       last column was clipped at the pane edge. Reported 2026-08-14 on the CS
       layer page, where the state column is one short word by design. */
    const html = renderMarkdown("| Tool | State | What it is for |\n| --- | --- | --- |\n| Switcher | live | Opens a workspace |");
    expect(html).toContain('<div class="wiki-table"><table>');
    expect(html).toContain("</table></div>");
  });

  it("renders a table", () => {
    const html = renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("strips dangerous HTML (no script or event handlers survive)", () => {
    const html = renderMarkdown("Hi <script>alert(1)</script> there");
    expect(html).not.toContain("<script>");
    expect(html.toLowerCase()).not.toContain("alert(1)</script");
    // A javascript: link target does not match the http/relative link rule, so it
    // never becomes an anchor (it stays inert text, not an executable href).
    const js = renderMarkdown("[x](javascript:alert(1))");
    expect(js).not.toContain("<a ");
    expect(js).not.toContain("href=");
  });

  it("returns empty string for empty / non-string input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(undefined as unknown as string)).toBe("");
  });
});
