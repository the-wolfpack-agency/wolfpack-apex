/**
 * text/html attachment extractor tests.
 *
 * Mirrors the parser-email-body HTML behavior: drop script/style,
 * collapse whitespace, preserve paragraph boundaries.
 */
import { extractHtml } from "../../extractors/html";

describe("extractHtml", () => {
  test("strips tags and preserves paragraph text", async () => {
    const html =
      "<html><body><p>Topic A</p><p>Topic B</p><script>x()</script></body></html>";
    const result = await extractHtml(Buffer.from(html), "text/html", "x.html");
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Topic A");
    expect(result.text).toContain("Topic B");
    expect(result.text).not.toContain("x()");
    expect(result.text).not.toContain("<");
  });

  test("empty buffer → extracted with empty text (cheerio tolerates it)", async () => {
    const result = await extractHtml(Buffer.from(""), "text/html", "x.html");
    expect(result.status).toBe("extracted");
    expect(result.text).toBe("");
  });

  test("flattens table-styled HTML", async () => {
    const html = `<table><tr><th>Name</th><td>Alice</td></tr></table>`;
    const result = await extractHtml(Buffer.from(html), "text/html", "x.html");
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Name");
    expect(result.text).toContain("Alice");
  });
});
