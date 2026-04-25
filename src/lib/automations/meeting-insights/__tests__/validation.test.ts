/**
 * Input-validation unit tests.
 */

import {
  validateFeedInput,
  validateFeedPatch,
  validateFilters,
} from "../validation";

describe("validateFilters", () => {
  it("rejects non-objects", () => {
    expect(validateFilters(null).ok).toBe(false);
    expect(validateFilters("x").ok).toBe(false);
    expect(validateFilters([]).ok).toBe(false);
  });

  it("accepts an empty filter shape", () => {
    const r = validateFilters({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sender_match).toEqual([]);
      expect(r.value.subject_match).toEqual([]);
    }
  });

  it("trims and drops empty entries", () => {
    const r = validateFilters({ sender_match: ["  hello  ", "", "world"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sender_match).toEqual(["hello", "world"]);
    }
  });

  it("rejects since when not a parseable date", () => {
    expect(validateFilters({ since: "not-a-date" }).ok).toBe(false);
  });

  it("preserves a valid since", () => {
    const r = validateFilters({ since: "2026-04-15T00:00:00Z" });
    expect(r.ok).toBe(true);
  });
});

describe("validateFeedInput", () => {
  it("requires name + filters", () => {
    expect(validateFeedInput({ filters: {} }).ok).toBe(false);
    expect(validateFeedInput({ name: "x" }).ok).toBe(false);
    expect(validateFeedInput({ name: "  ", filters: {} }).ok).toBe(false);
  });

  it("happy path", () => {
    const r = validateFeedInput({
      name: "Vendor",
      description: "weekly",
      filters: { sender_match: ["@v.com"], subject_match: [] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Vendor");
      expect(r.value.is_enabled).toBe(true);
    }
  });

  it("rejects oversized name", () => {
    const r = validateFeedInput({
      name: "x".repeat(500),
      filters: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateFeedPatch", () => {
  it("empty patch is OK", () => {
    expect(validateFeedPatch({}).ok).toBe(true);
  });

  it("name=empty rejected", () => {
    expect(validateFeedPatch({ name: "" }).ok).toBe(false);
  });

  it("description=null is allowed (clears it)", () => {
    const r = validateFeedPatch({ description: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBeNull();
  });
});
