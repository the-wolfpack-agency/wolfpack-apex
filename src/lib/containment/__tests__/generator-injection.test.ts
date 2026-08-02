/**
 * Auditing the generators by RUNNING them, not by reading them.
 *
 * The untrusted-content ratchet lists files that build markup from a template
 * literal. Clearing a file off that list means claiming it is safe, and a claim
 * nobody measured is the thing this codebase keeps deleting. Reading the code
 * is not measurement: an earlier audit in this repo hypothesised an attribute
 * breakout in markdown.ts, tested it, and was wrong.
 *
 * So each generator here is fed input designed to escape, and the OUTPUT is
 * checked. The assertions are about what survives into the result, which is the
 * only thing an attacker cares about.
 *
 * WHY THE ASSERTIONS DO NOT SAY toContain("<script>")
 *
 * A payload appearing in the output is not automatically a bug — the whole
 * point of escaping is that it appears, inert. The question is whether it
 * appears as SYNTAX or as TEXT. So the checks look for an unescaped angle
 * bracket that could open an element, not for the payload's presence, which is
 * the mistake an earlier proxy assertion in this repo made.
 */
// jsdom imported directly rather than via @jest-environment. report-templates
// reaches src/lib/db, and pg's crypto does not load in a jsdom environment —
// so the parser comes to the test instead of the test moving to the parser.
import { JSDOM } from "jsdom";
import { renderReportHtml } from "../../report-templates";
import { renderQrSvg } from "../../qr/svg";
import { paletteToFaviconSvg, resolveMonogram } from "../../favicon-generator";

/** Things that try to become syntax. */
const PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `</title><svg onload=alert(1)>`,
  `'"><svg/onload=alert(1)>`,
  `<!--<script>alert(1)</script>-->`,
];

/**
 * Verified with a real HTML parser, not a regular expression.
 *
 * I tried the regex twice and it was wrong both times, in opposite directions.
 * First it matched any `<tag` and flagged the generators' own <title>, <style>
 * and </svg> as injections — five vulnerabilities that did not exist. Then it
 * matched `on...=` inside `href="&quot; onmouseover=&quot;alert(1"`, which is
 * an entity sequence sitting INSIDE a quoted attribute value and executes
 * nothing. A regex cannot tell an attribute boundary from a character that
 * merely looks like one, because that is precisely the job of a parser.
 *
 * So the check parses the output the way a browser would and asks the DOM the
 * question directly: is there an element that runs code, and does any element
 * carry an event-handler attribute. Those are the only two answers that matter,
 * and neither is a guess.
 */
const EXECUTABLE_TAGS = ["script", "iframe", "object", "embed"];

function parse(markup: string): Document {
  return new JSDOM(markup).window.document;
}

/** Nothing in this output executes. */
function expectInert(output: string) {
  const doc = parse(output);

  const executable = EXECUTABLE_TAGS.flatMap((tag) => [...doc.querySelectorAll(tag)]).map((el) => el.tagName);
  expect({ where: "executable elements", found: executable }).toEqual({ where: "executable elements", found: [] });

  const handlers: string[] = [];
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (attr.name.toLowerCase().startsWith("on")) handlers.push(`${el.tagName}[${attr.name}]`);
    }
  }
  expect({ where: "event handlers", found: handlers }).toEqual({ where: "event handlers", found: [] });
}

/** The href a browser would actually resolve, after entity decoding. */
function hrefOf(html: string): string | null {
  return parse(html).querySelector("a.wp-link")?.getAttribute("href") ?? null;
}

describe("report-templates renderReportHtml", () => {
  it.each(PAYLOADS)("does not let %s become an element", (payload) => {
    const html = renderReportHtml(`# Report\n\n${payload}\n`);
    // The payload text may appear; it must not appear as syntax.
    expectInert(html);
  });

  it("escapes before it formats, which is the property the whole renderer rests on", () => {
    // If a transformation ran first, its output would contain raw < that the
    // escaper would then mangle, or worse, would not see at all.
    const html = renderReportHtml(`<b>not bold</b>`);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("keeps a payload inside a table cell as text", () => {
    // The table path builds <td> from split text, which is the most syntax-like
    // construction in the file.
    const html = renderReportHtml(`| ${"<script>alert(1)</script>"} | b |`);
    expectInert(html);
    // Present as TEXT, which is what escaping is for. The parser proves it is
    // text: it appears in textContent, and expectInert proved no script node.
    expect(parse(html).body.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps a payload inside a link target as text", () => {
    // THE REAL FINDING. The URL lands inside a double-quoted href, and the
    // renderer's escaper handles & < > but not the quote character — so
    // `[click](" onmouseover="alert(1))` rendered
    //   <a href="" onmouseover="alert(1" class="wp-link">
    // with a live handler. Reports are generated from AI output and shown to
    // people, so this was reachable.
    const html = renderReportHtml(`[click](" onmouseover="alert(1))`);
    expectInert(html);
    // Present, and trapped: the browser resolves it as ONE href attribute
    // whose value happens to contain the text, not as a second attribute.
    expect(hrefOf(html)).toBe(`" onmouseover="alert(1`);
  });

  it("refuses a javascript: URL rather than escaping it and hoping", () => {
    // Escaping a javascript: URL leaves it working. The scheme has to be
    // rejected, which is why this is an allow-list and not an escaper.
    const html = renderReportHtml(`[x](javascript:alert(1))`);
    expect(hrefOf(html)).toBe("#");
    expect(html).not.toContain("javascript:");
  });

  it.each(["data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "JaVaScRiPt:alert(1)"])(
    "refuses %s",
    (url) => {
      expect(hrefOf(renderReportHtml(`[x](${url})`))).toBe("#");
    },
  );

  it("still links the URLs a real report uses", () => {
    // A fix that breaks every legitimate link passes the security test and
    // ships a broken report.
    // Asserted as the browser resolves them, so &amp; is compared decoded.
    expect(hrefOf(renderReportHtml(`[a](https://example.com/x?b=1&c=2)`))).toBe("https://example.com/x?b=1&c=2");
    expect(hrefOf(renderReportHtml(`[b](/reports/1)`))).toBe("/reports/1");
    expect(hrefOf(renderReportHtml(`[c](mailto:a@b.com)`))).toBe("mailto:a@b.com");
    expect(hrefOf(renderReportHtml(`[d](#section)`))).toBe("#section");
  });

  it("still renders ordinary markdown, so the escaping did not break the feature", () => {
    // A generator that escapes everything into uselessness passes every
    // security test and ships a broken report.
    const html = renderReportHtml(`## Heading\n\n- one\n- two\n`);
    expect(html).toContain("<h2");
    expect(html).toContain("<li>one</li>");
  });
});

describe("qr/svg renderQrSvg", () => {
  it.each(PAYLOADS)("does not let %s become an element in the SVG", (payload) => {
    // An SVG is served and rendered; an injected element here executes.
    expectInert(renderQrSvg(payload));
  });

  it("encodes the payload as QR data rather than emitting it", () => {
    // The text becomes modules, not markup: there is no interpolation of the
    // input into the document at all, which is the strongest form of safe.
    const svg = renderQrSvg("<script>alert(1)</script>");
    expect(svg).not.toContain("alert(1)");
  });

  it("still produces a usable SVG", () => {
    const svg = renderQrSvg("https://example.com");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
  });
});

describe("favicon-generator", () => {
  it("reduces a hostile monogram to characters that cannot be syntax", () => {
    // The monogram is interpolated into SVG text. It comes from a brief, which
    // is AI-extracted from an uploaded document — untrusted twice over.
    for (const payload of PAYLOADS) {
      const mono = resolveMonogram({ client: payload, product: { name: payload } } as never);
      expect(mono).not.toMatch(/[<>&"']/);
    }
  });

  it.each(PAYLOADS)("does not let %s become an element in the favicon SVG", (payload) => {
    expectInert(paletteToFaviconSvg({ bg: "#000000", fg: "#ffffff", monogram: payload }));
  });

  it("rejects a colour that is not a colour, rather than interpolating it", () => {
    // bg and fg land inside a fill attribute. A value like `#000" onload="x`
    // would break out of the attribute if it were passed through.
    expectInert(paletteToFaviconSvg({ bg: `#000" onload="alert(1)`, fg: "#ffffff", monogram: "AB" }));
  });

  it("still produces a usable favicon", () => {
    const svg = paletteToFaviconSvg({ bg: "#112233", fg: "#ffffff", monogram: "WA" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("WA");
  });
});
