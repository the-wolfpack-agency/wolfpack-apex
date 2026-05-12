 
import {
  parseMarkdown,
  parseSection,
  slugify,
  sha256Hex,
  docXmlToMarkdown,
} from "@/lib/principles/parser";
import { encodeSharingUrl } from "@/lib/principles/sharepoint-fetch";

describe("docXmlToMarkdown", () => {
  test("plain paragraph → plain text line", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>Hello world</w:t></w:r></w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("Hello world");
  });

  test("Heading2 paragraph → ## prefix", () => {
    const xml = `<w:document><w:body>
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Principle: Ship before perfect</w:t></w:r>
      </w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("## Principle: Ship before perfect");
  });

  test("bold run → wrapped in **...**", () => {
    const xml = `<w:document><w:body>
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Domain:</w:t></w:r>
        <w:r><w:t xml:space="preserve"> code, comms</w:t></w:r>
      </w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("**Domain:** code, comms");
  });

  test("multiple paragraphs, mixed styles", () => {
    const xml = `<w:document><w:body>
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Principle: Respect off-hours</w:t></w:r>
      </w:p>
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Domain:</w:t></w:r>
        <w:r><w:t xml:space="preserve"> mail</w:t></w:r>
      </w:p>
      <w:p><w:r><w:t>We protect each other's evenings.</w:t></w:r></w:p>
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Counter-signal:</w:t></w:r>
        <w:r><w:t xml:space="preserve"> outbound mail/Teams sent 9pm-7am local</w:t></w:r>
      </w:p>
    </w:body></w:document>`;
    const out = docXmlToMarkdown(xml);
    expect(out).toContain("## Principle: Respect off-hours");
    expect(out).toContain("**Domain:** mail");
    expect(out).toContain("We protect each other");
    expect(out).toContain("**Counter-signal:** outbound mail/Teams sent 9pm-7am local");
  });

  test("empty paragraph emits blank line; 3+ blanks collapse to 1", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>A</w:t></w:r></w:p>
      <w:p></w:p>
      <w:p></w:p>
      <w:p></w:p>
      <w:p><w:r><w:t>B</w:t></w:r></w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("A\n\nB");
  });

  test("decodes basic XML entities (&amp; &lt; &gt;)", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>Tom &amp; Jerry &lt;3</w:t></w:r></w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("Tom & Jerry <3");
  });

  test("whitespace-only bold run is NOT wrapped (avoids ** ** artifact)", () => {
    const xml = `<w:document><w:body>
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">  </w:t></w:r>
        <w:r><w:t>plain</w:t></w:r>
      </w:p>
    </w:body></w:document>`;
    expect(docXmlToMarkdown(xml)).toBe("  plain");
  });
});

describe("slugify", () => {
  test("lowercases, replaces non-alphanumeric, trims", () => {
    expect(slugify("Ship before perfect")).toBe("ship-before-perfect");
    expect(slugify("  Trust & Verify!  ")).toBe("trust-verify");
    expect(slugify("___")).toBe("");
  });
  test("caps at 80 chars", () => {
    expect(slugify("a".repeat(120))).toHaveLength(80);
  });
});

describe("sha256Hex", () => {
  test("string and buffer produce the same digest", () => {
    expect(sha256Hex("hi")).toBe(sha256Hex(Buffer.from("hi")));
  });
  test("changes when input changes", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("parseSection — happy path", () => {
  const md = `## Principle: Ship before perfect
**Domain:** code, comms
**Owner:** Hoxsie
**Effective:** 2026-05-01
**Scoreboard weight:** 3

We optimize for cycle time over polish on internal tools. The
client surface is the only place perfection matters.

**Signal:** PR cycle time < 48h
**Signal:** No more than 2 reviewers requested per PR
**Counter-signal:** PRs sitting open >5 days without comments`;

  const { principle, warnings } = parseSection(md);

  test("extracts core fields", () => {
    expect(warnings).toEqual([]);
    expect(principle).not.toBeNull();
    expect(principle!.slug).toBe("ship-before-perfect");
    expect(principle!.title).toBe("Ship before perfect");
    expect(principle!.domains).toEqual(["code", "comms"]);
    expect(principle!.owner).toBe("Hoxsie");
    expect(principle!.effectiveAt).toBe("2026-05-01");
    expect(principle!.scoreboardWeight).toBe(3);
  });
  test("extracts repeated Signal / Counter-signal lines", () => {
    expect(principle!.signals).toEqual([
      "PR cycle time < 48h",
      "No more than 2 reviewers requested per PR",
    ]);
    expect(principle!.counterSignals).toEqual([
      "PRs sitting open >5 days without comments",
    ]);
  });
  test("body markdown has field markers stripped", () => {
    expect(principle!.bodyMd).toContain("optimize for cycle time");
    expect(principle!.bodyMd).not.toContain("**Domain:**");
    expect(principle!.bodyMd).not.toContain("**Signal:**");
  });
});

describe("parseSection — lenient format (what users actually type)", () => {
  test("plain-text 'Principle:' (no ## prefix) is recognized", () => {
    const md = `Principle: Respect off-hours
Domain: mail
Owner: Hoxsie
Counter-signal: outbound mail/Teams sent 9pm-7am local`;
    const { principle } = parseSection(md);
    expect(principle).not.toBeNull();
    expect(principle!.title).toBe("Respect off-hours");
    expect(principle!.domains).toEqual(["mail"]);
    expect(principle!.owner).toBe("Hoxsie");
    expect(principle!.counterSignals).toEqual([
      "outbound mail/Teams sent 9pm-7am local",
    ]);
  });

  test("inline-listed fields on one line are split properly", () => {
    const md = `Principle: Respect off-hours
Domain: mail Owner: Hoxsie Scoreboard weight: 3
We protect each other's evenings.
Counter-signal: outbound mail/Teams sent 9pm-7am local`;
    const { principle } = parseSection(md);
    expect(principle).not.toBeNull();
    expect(principle!.domains).toEqual(["mail"]);
    expect(principle!.owner).toBe("Hoxsie");
    expect(principle!.scoreboardWeight).toBe(3);
    expect(principle!.counterSignals).toHaveLength(1);
    expect(principle!.bodyMd).toContain("We protect each other");
  });

  test("plain (no bold) and bold-wrapped fields produce the same result", () => {
    const plain = parseSection(
      `Principle: X\nDomain: code\nSignal: foo`,
    );
    const bold = parseSection(
      `## Principle: X\n**Domain:** code\n**Signal:** foo`,
    );
    expect(plain.principle?.domains).toEqual(bold.principle?.domains);
    expect(plain.principle?.signals).toEqual(bold.principle?.signals);
  });
});

describe("parseSection — defaults + warnings", () => {
  test("missing Domain → cross_cutting + warning", () => {
    const md = `## Principle: Trust the data
Some prose here.
**Signal:** trust score > 0.8`;
    const { principle, warnings } = parseSection(md);
    expect(principle!.domains).toEqual(["cross_cutting"]);
    expect(warnings.find((w) => w.includes("no Domain"))).toBeTruthy();
  });

  test("invalid Effective date warns + leaves null", () => {
    const md = `## Principle: X
**Domain:** code
**Effective:** sometime soon
**Signal:** s`;
    const { principle, warnings } = parseSection(md);
    expect(principle!.effectiveAt).toBeNull();
    expect(warnings.find((w) => w.includes("Effective date"))).toBeTruthy();
  });

  test("Scoreboard weight outside 1–5 warns + clamps to 1", () => {
    const md = `## Principle: X
**Domain:** code
**Scoreboard weight:** 99
**Signal:** s`;
    const { principle, warnings } = parseSection(md);
    expect(principle!.scoreboardWeight).toBe(1);
    expect(warnings.find((w) => w.includes("Scoreboard weight"))).toBeTruthy();
  });

  test("no Signal AND no Counter-signal warns (descriptive-only)", () => {
    const md = `## Principle: Tone
**Domain:** comms

Be kind.`;
    const { principle, warnings } = parseSection(md);
    expect(principle!.signals).toEqual([]);
    expect(principle!.counterSignals).toEqual([]);
    expect(
      warnings.find((w) => w.includes("descriptive only")),
    ).toBeTruthy();
  });

  test("non-principle ## sections are silently ignored", () => {
    const { principle, warnings } = parseSection("## Background\n\nSome context.");
    expect(principle).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("Principle section with empty title produces a warning + null", () => {
    const { principle, warnings } = parseSection("## Principle: ");
    expect(principle).toBeNull();
    expect(warnings[0]).toMatch(/empty title/);
  });
});

describe("parseMarkdown — full doc", () => {
  const md = `# Wolfpack Operating Principles

Some preamble that should be ignored.

## Background

Internal context.

## Principle: Ship before perfect
**Domain:** code
**Signal:** cycle time < 48h

## Principle: Respect off-hours
**Domain:** comms, calendar
**Owner:** Hoxsie
**Counter-signal:** outbound mail/Teams sent 9pm–7am local

Free prose explanation.

## Principle: Ship before perfect
**Domain:** code
**Signal:** updated definition

## Principle:
`;

  test("parses multiple principles and reports duplicates + empty title", () => {
    const out = parseMarkdown(md);
    /* Two unique principles after dedupe — `Ship before perfect` later
       definition wins. The empty-title section is skipped. */
    expect(out.principles).toHaveLength(2);
    const ship = out.principles.find((p) => p.slug === "ship-before-perfect");
    expect(ship).toBeTruthy();
    /* Later definition's signal wins. */
    expect(ship!.signals).toEqual(["updated definition"]);
    const offHours = out.principles.find((p) => p.slug === "respect-off-hours");
    expect(offHours).toBeTruthy();
    expect(offHours!.domains).toEqual(["comms", "calendar"]);
    expect(offHours!.counterSignals[0]).toContain("outbound mail/Teams");

    expect(
      out.warnings.find((w) => w.includes("Duplicate principle slug")),
    ).toBeTruthy();
    expect(out.warnings.find((w) => w.includes("empty title"))).toBeTruthy();
  });

  test("sourceHash is stable for the same input + changes on edit", () => {
    const a = parseMarkdown("## Principle: A\n**Domain:** code\n**Signal:** s");
    const b = parseMarkdown("## Principle: A\n**Domain:** code\n**Signal:** s");
    const c = parseMarkdown("## Principle: A\n**Domain:** code\n**Signal:** changed");
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).not.toBe(c.sourceHash);
  });

  test("zero principles + zero warnings on a doc with no principle markers", () => {
    const out = parseMarkdown("# Notes\n\nNo principle headings here.");
    expect(out.principles).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});

describe("encodeSharingUrl (Graph share-id format)", () => {
  test("returns u!<base64url-encoded URL> with no padding/+///", () => {
    const url = "https://example.sharepoint.com/sites/x/Doc.docx";
    const enc = encodeSharingUrl(url);
    expect(enc.startsWith("u!")).toBe(true);
    expect(enc).not.toMatch(/=/);
    expect(enc).not.toMatch(/\+/);
    expect(enc).not.toMatch(/\//);
    /* Round-trip: base64url-decode the body should match the input URL. */
    const body = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
    expect(Buffer.from(padded, "base64").toString("utf-8")).toBe(url);
  });
});
