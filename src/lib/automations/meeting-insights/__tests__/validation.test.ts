/**
 * Input-validation unit tests.
 */

import {
  validateAnalyzeRequest,
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

describe("validateAnalyzeRequest", () => {
  it("rejects non-objects", () => {
    expect(validateAnalyzeRequest(null).ok).toBe(false);
    expect(validateAnalyzeRequest([]).ok).toBe(false);
  });

  it("rejects when both filter arrays are empty", () => {
    expect(validateAnalyzeRequest({ subject_match: [], sender_match: [] }).ok).toBe(false);
  });

  it("accepts subject-only filters", () => {
    const r = validateAnalyzeRequest({ subject_match: ["weekly"], sender_match: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.subject_match).toEqual(["weekly"]);
  });

  it("rejects since>until", () => {
    expect(
      validateAnalyzeRequest({
        subject_match: ["x"],
        sender_match: [],
        since: "2026-05-01",
        until: "2026-04-01",
      }).ok,
    ).toBe(false);
  });

  it("trims and drops empty entries", () => {
    const r = validateAnalyzeRequest({
      subject_match: ["  weekly ", "", "  "],
      sender_match: [],
    });
    if (r.ok) expect(r.value.subject_match).toEqual(["weekly"]);
  });

  it("rejects bad date strings", () => {
    expect(
      validateAnalyzeRequest({
        subject_match: ["x"],
        sender_match: [],
        since: "not-a-date",
      }).ok,
    ).toBe(false);
  });

  it("treats empty since/until strings as undefined", () => {
    const r = validateAnalyzeRequest({
      subject_match: ["x"],
      sender_match: [],
      since: "",
      until: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.since).toBeUndefined();
      expect(r.value.until).toBeUndefined();
    }
  });
});
