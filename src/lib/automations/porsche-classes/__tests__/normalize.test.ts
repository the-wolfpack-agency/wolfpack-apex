/**
 * Tests for porsche-classes/normalize — name + location + class_key
 * normalization edge cases.
 */

import {
  normalizeName,
  normalizeLocation,
  buildClassKey,
  participantHash,
  canonicalParticipants,
  normalizeClass,
} from "../normalize";

describe("normalizeName", () => {
  it("lowercases and trims", () => {
    expect(normalizeName("  John Smith  ")).toBe("john smith");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeName("john   smith")).toBe("john smith");
  });

  it("strips quotes / commas / periods / parens", () => {
    expect(normalizeName(`Smith, John "JJ" (Jr.)`)).toBe("smith john jj jr");
  });

  it("keeps diacritics intact", () => {
    expect(normalizeName("José Fernández")).toBe("josé fernández");
  });

  it("returns empty string for null / undefined / empty", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });
});

describe("normalizeLocation", () => {
  it("title-cases lowercase input", () => {
    expect(normalizeLocation("hilton hotel")).toBe("Hilton Hotel");
  });

  it("normalizes ALL CAPS to title case (preserving short acronyms)", () => {
    expect(normalizeLocation("HILTON HOTEL")).toBe("Hilton Hotel");
  });

  it("preserves short acronyms (≤3 caps)", () => {
    expect(normalizeLocation("USA training center")).toBe("USA Training Center");
    expect(normalizeLocation("NYC office")).toBe("NYC Office");
  });

  it("title-cases longer ALL-CAPS words (4+ chars) so source casing doesn't fork the key", () => {
    expect(normalizeLocation("HILTON HOTEL")).toBe("Hilton Hotel");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeLocation("Four    Seasons   Hotel")).toBe("Four Seasons Hotel");
  });

  it("returns empty for null / empty", () => {
    expect(normalizeLocation(null)).toBe("");
    expect(normalizeLocation("")).toBe("");
  });
});

describe("buildClassKey", () => {
  it("composes course|date|location with normalized location", () => {
    expect(buildClassKey("BA101", "2026-04-13", "hilton hotel")).toBe(
      "BA101|2026-04-13|Hilton Hotel",
    );
  });

  it("rejects non-ISO dates", () => {
    expect(() => buildClassKey("BA101", "Apr 13 2026", "x")).toThrow(/YYYY-MM-DD/);
    expect(() => buildClassKey("BA102", "13/04/2026", "x")).toThrow(/YYYY-MM-DD/);
  });

  it("is deterministic across input variants", () => {
    const a = buildClassKey("BA101", "2026-04-13", "Hilton Hotel");
    const b = buildClassKey("BA101", "2026-04-13", "HILTON HOTEL");
    const c = buildClassKey("BA101", "2026-04-13", "hilton hotel");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("canonicalParticipants", () => {
  it("dedupes case-insensitively", () => {
    expect(canonicalParticipants(["John Smith", "JOHN SMITH", "john smith"])).toEqual([
      "john smith",
    ]);
  });

  it("sorts the result lexicographically", () => {
    expect(canonicalParticipants(["Zoe Wong", "Alex Doe", "Brad Lee"])).toEqual([
      "alex doe",
      "brad lee",
      "zoe wong",
    ]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(canonicalParticipants(["John", "", "  ", "Jane"])).toEqual(["jane", "john"]);
  });
});

describe("participantHash", () => {
  it("is stable across input order + casing", () => {
    const a = participantHash(["John Smith", "Jane Doe"]);
    const b = participantHash(["jane doe", "JOHN SMITH"]);
    expect(a).toBe(b);
  });

  it("differs when membership differs", () => {
    const a = participantHash(["John"]);
    const b = participantHash(["Jane"]);
    expect(a).not.toBe(b);
  });

  it("is hex sha256 (64 chars)", () => {
    expect(participantHash(["x"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalizeClass", () => {
  it("returns a fully normalized class shape", () => {
    const c = normalizeClass({
      course_type: "BA101",
      class_date: "2026-04-13",
      location: "hilton  hotel",
      participants: ["John Smith", "JOHN SMITH", "  Jane Doe  "],
    });
    expect(c).toEqual({
      course_type: "BA101",
      class_date: "2026-04-13",
      location: "Hilton Hotel",
      participants: ["jane doe", "john smith"],
    });
  });
});
