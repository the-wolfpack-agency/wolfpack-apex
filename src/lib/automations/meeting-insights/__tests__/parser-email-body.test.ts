/**
 * parser-email-body fixture tests.
 *
 * Real-shape fixtures — small handwritten HTML and plain-text bodies that
 * mirror the Microsoft Graph message.body shape.
 */
import { parseEmailBody, htmlToPlainText } from "../parser-email-body";

describe("htmlToPlainText", () => {
  test("strips script and style tags entirely (contents + tags)", () => {
    const html = `<p>Hello</p><script>alert('x')</script><style>p{color:red}</style><p>World</p>`;
    const out = htmlToPlainText(html);
    expect(out).not.toContain("alert");
    expect(out).not.toContain("color:red");
    expect(out).toContain("Hello");
    expect(out).toContain("World");
  });

  test("preserves paragraph breaks across <p>/<br>/<li>", () => {
    const html = `<p>Para one.</p><p>Para two.</p><ul><li>A</li><li>B</li></ul>Line<br>Break`;
    const out = htmlToPlainText(html);
    expect(out.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "Para one.",
      "Para two.",
      "A",
      "B",
      "Line",
      "Break",
    ]);
  });

  test("collapses internal whitespace runs to single space", () => {
    const html = `<p>foo    bar\t\tbaz</p>`;
    expect(htmlToPlainText(html)).toBe("foo bar baz");
  });

  test("flattens tables with inline styles cleanly", () => {
    const html = `
      <table style="border:1px solid #000">
        <tr><th>Name</th><td>Alice</td></tr>
        <tr><th>Role</th><td>Engineer</td></tr>
      </table>`;
    const out = htmlToPlainText(html);
    expect(out).toContain("Name");
    expect(out).toContain("Alice");
    expect(out).toContain("Role");
    expect(out).toContain("Engineer");
    // Should not include the inline style attribute or any '<' chars.
    expect(out).not.toContain("border:1px");
    expect(out).not.toContain("<");
  });

  test("returns empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  test("does not produce triple-newlines from stacked empty blocks", () => {
    const html = `<p>A</p><p></p><p></p><p>B</p>`;
    const out = htmlToPlainText(html);
    // No more than one blank line between paragraphs.
    expect(out).not.toMatch(/\n\n\n/);
  });

  test("decodes HTML entities via cheerio's .text()", () => {
    const html = `<p>5 &lt; 10 &amp; 10 &gt; 5 &mdash; correct</p>`;
    expect(htmlToPlainText(html)).toBe("5 < 10 & 10 > 5 — correct");
  });
});

describe("parseEmailBody", () => {
  test("text body returns content as-is, body_html = null", () => {
    const result = parseEmailBody({
      contentType: "text",
      content: "Hello, this is a plain text email.\n\nSecond paragraph.",
    });
    expect(result).toEqual({
      body_text: "Hello, this is a plain text email.\n\nSecond paragraph.",
      body_html: null,
    });
  });

  test("html body strips to text and preserves original in body_html", () => {
    const html =
      "<html><body><p>Hello.</p><p>This is <b>bold</b>.</p></body></html>";
    const result = parseEmailBody({ contentType: "html", content: html });
    expect(result.body_html).toBe(html);
    expect(result.body_text).toContain("Hello.");
    expect(result.body_text).toContain("This is bold.");
    expect(result.body_text).not.toContain("<");
  });

  test("empty body returns empty body_text + null body_html", () => {
    expect(parseEmailBody({ contentType: "html", content: "" })).toEqual({
      body_text: "",
      body_html: null,
    });
    expect(parseEmailBody({ contentType: "text", content: "" })).toEqual({
      body_text: "",
      body_html: null,
    });
  });

  test("contentType matching is case-insensitive", () => {
    const html = "<p>X</p>";
    const upper = parseEmailBody({ contentType: "HTML", content: html });
    expect(upper.body_html).toBe(html);
    expect(upper.body_text).toBe("X");
  });

  test("unknown contentType falls back to plain-text passthrough", () => {
    const result = parseEmailBody({
      contentType: "weirdtype",
      content: "raw payload",
    });
    expect(result).toEqual({ body_text: "raw payload", body_html: null });
  });

  test("HTML body with weird tables + inline styles flattens cleanly", () => {
    const html = `
      <html>
        <head><style>p { color: red }</style></head>
        <body>
          <table style="width:100%">
            <tr><th>Topic</th><td>Q2 Goals</td></tr>
            <tr><th>Owner</th><td>Nick</td></tr>
          </table>
          <p style="font-size:12px">Notes follow:</p>
          <ul>
            <li>One</li>
            <li>Two</li>
          </ul>
        </body>
      </html>`;
    const result = parseEmailBody({ contentType: "html", content: html });
    expect(result.body_html).toBe(html);
    const text = result.body_text;
    // No raw HTML or CSS leaked.
    expect(text).not.toContain("<");
    expect(text).not.toContain("font-size");
    expect(text).not.toContain("color: red");
    // Logical content is preserved.
    expect(text).toContain("Topic");
    expect(text).toContain("Q2 Goals");
    expect(text).toContain("Owner");
    expect(text).toContain("Nick");
    expect(text).toContain("Notes follow:");
    expect(text).toContain("One");
    expect(text).toContain("Two");
  });
});
