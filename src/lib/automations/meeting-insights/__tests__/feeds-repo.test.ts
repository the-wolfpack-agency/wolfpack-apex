/**
 * feeds-repo unit tests — focuses on the pure helpers (slug
 * generation, filter normalization, union). DB-touching paths
 * (createFeed/updateFeed) are covered in the API integration test
 * via mocked writeQuery.
 */

import { nameToSlug, normalizeFilters } from "../feeds-repo";

describe("nameToSlug", () => {
  it("kebab-cases a typical name", () => {
    expect(nameToSlug("Porsche Weekly Stand-up")).toBe("porsche-weekly-stand-up");
  });

  it("strips diacritics + non-alphanumerics", () => {
    expect(nameToSlug("Café résumé!")).toBe("cafe-resume");
  });

  it("returns 'feed' for an empty name", () => {
    expect(nameToSlug("")).toBe("feed");
    expect(nameToSlug("!!!")).toBe("feed");
  });

  it("trims to 64 characters", () => {
    const long = "a".repeat(200);
    expect(nameToSlug(long).length).toBeLessThanOrEqual(64);
  });
});

describe("normalizeFilters", () => {
  it("coerces undefined to safe defaults", () => {
    const f = normalizeFilters(undefined);
    expect(f.sender_match).toEqual([]);
    expect(f.subject_match).toEqual([]);
    expect(f.since).toBeUndefined();
  });

  it("preserves arrays + since", () => {
    const f = normalizeFilters({
      sender_match: ["@a"],
      subject_match: ["b"],
      since: "2026-04-15T00:00:00Z",
    });
    expect(f.sender_match).toEqual(["@a"]);
    expect(f.since).toBe("2026-04-15T00:00:00Z");
  });

  it("coerces non-arrays to []", () => {
    const f = normalizeFilters({ sender_match: "broken" });
    expect(f.sender_match).toEqual([]);
  });
});
