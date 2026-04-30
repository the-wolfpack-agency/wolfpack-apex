/**
 * Unit tests for the Graph search keyword extractor.
 *
 * The function is the core fix for the SharePoint/Mail "200 OK but 0 hits"
 * bug we hit in prod: passing a verbatim natural-language question to
 * Graph's `/search/query` endpoint. These tests are table-driven so the
 * algorithm contract is unambiguous.
 */

import {
  buildSearchQueryString,
  __internal,
} from "@/lib/integrations/microsoft-search-keywords";

describe("buildSearchQueryString — table cases", () => {
  /**
   * The exact contract from the bug ticket. Every row here corresponds to
   * a real failure mode the diagnostic page surfaced.
   */
  const cases: Array<[string, string]> = [
    /* The prod failing case: filler words have to be dropped, the acronym
       and proper noun and date kept. */
    ["What's in the TWA Agenda 4.20 doc?", "TWA Agenda 4.20"],
    /* Filename should be preserved verbatim, including its dots. */
    ["summarize the TWA_Agenda_4.20.docx", "TWA_Agenda_4.20.docx"],
    /* "who", "attended", "the" all dropped. Proper noun + plain nouns kept. */
    ["who attended the March porsche meetings?", "March porsche meetings"],
    /* "pull", "up", "the" dropped. Q1 (alphanumeric) + budget + xlsx kept. */
    ["pull up the Q1 budget xlsx", "Q1 budget xlsx"],
    /* Quoted phrase preserved verbatim, surrounding verb dropped. */
    ['Search for "intro deck"', '"intro deck"'],
    /* Degenerate fallback: nothing extractable, return trimmed original. */
    ["?", "?"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(buildSearchQueryString(input)).toBe(expected);
  });

  it("returns empty string for empty input", () => {
    expect(buildSearchQueryString("")).toBe("");
    expect(buildSearchQueryString("   ")).toBe("");
  });

  it("normalizes smart apostrophes so stopwords still match", () => {
    /* User types with curly quotes from Office; without normalization,
       "what’s" wouldn't match the "what's" stopword. */
    const out = buildSearchQueryString("What’s in the TWA Agenda 4.20 doc?");
    expect(out).toBe("TWA Agenda 4.20");
  });

  it("preserves multiple file tokens", () => {
    const out = buildSearchQueryString("compare report.pdf and summary.docx");
    expect(out).toContain("report.pdf");
    expect(out).toContain("summary.docx");
  });

  it("preserves multiple quoted phrases", () => {
    const out = buildSearchQueryString('search for "intro deck" or "pricing FAQ"');
    expect(out).toContain('"intro deck"');
    expect(out).toContain('"pricing FAQ"');
  });

  it("always emits acronyms even when surrounded by junk", () => {
    /* "PCNA" should survive even though everything around it is filler. */
    expect(buildSearchQueryString("what about the PCNA report?")).toContain("PCNA");
  });

  it("dedupes acronyms when the inline pass already pushed them", () => {
    const out = buildSearchQueryString("the TWA TWA agenda");
    /* TWA must appear once, not twice. */
    const matches = out.match(/TWA/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("keeps standalone numbers and version strings", () => {
    expect(buildSearchQueryString("what's the 2026 plan")).toContain("2026");
    expect(buildSearchQueryString("upgrade to v1.2.3")).toContain("1.2.3");
  });

  it("falls back to the raw question when nothing keyword-worthy survives", () => {
    /* All-stopword sentence — fallback so Graph still gets something. */
    const out = buildSearchQueryString("the a an");
    expect(out).toBe("the a an");
  });

  it("handles questions with trailing punctuation", () => {
    expect(buildSearchQueryString("Q1 budget!!!")).toBe("Q1 budget");
  });

  it("never leaks the literal `__FROZEN_F<n>__` / `__FROZEN_Q<n>__` placeholder", () => {
    /* Defensive: regardless of input, our placeholder markers must never
       appear in the returned string. */
    const samples = [
      "the agenda.docx for Q1",
      'find "intro deck" please',
      "compare report.pdf and summary.docx",
    ];
    for (const s of samples) {
      const out = buildSearchQueryString(s);
      expect(out).not.toMatch(/__FROZEN_[FQ]\d+__/);
    }
  });
});

describe("buildSearchQueryString — internal helpers", () => {
  it("isNumberLike accepts integers and dotted versions", () => {
    expect(__internal.isNumberLike("4")).toBe(true);
    expect(__internal.isNumberLike("4.20")).toBe(true);
    expect(__internal.isNumberLike("1.2.3")).toBe(true);
    expect(__internal.isNumberLike("Q1")).toBe(false);
    expect(__internal.isNumberLike("4abc")).toBe(false);
  });

  it("isProperNoun requires leading capital + non-zero index", () => {
    expect(__internal.isProperNoun("Apple", 0)).toBe(false);
    expect(__internal.isProperNoun("Apple", 1)).toBe(true);
    expect(__internal.isProperNoun("apple", 1)).toBe(false);
    expect(__internal.isProperNoun("APPLE", 1)).toBe(false);
  });

  it("freezeRuns substitutes file tokens and quoted phrases with placeholders", () => {
    const { masked, runs } = __internal.freezeRuns(
      'pull up "intro deck" from agenda.docx',
    );
    expect(masked).toMatch(/__FROZEN_Q\d+__/);
    expect(masked).toMatch(/__FROZEN_F\d+__/);
    expect(runs.some((r) => r.original === '"intro deck"')).toBe(true);
    expect(runs.some((r) => r.original === "agenda.docx")).toBe(true);
  });
});
