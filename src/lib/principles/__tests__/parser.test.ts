/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  parseMarkdown,
  parseSection,
  slugify,
  sha256Hex,
} from "@/lib/principles/parser";
import { encodeSharingUrl } from "@/lib/principles/sharepoint-fetch";

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
