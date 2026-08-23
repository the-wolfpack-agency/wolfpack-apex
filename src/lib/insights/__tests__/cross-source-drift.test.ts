/**
 * Two systems, one truth, and the ways this could lie.
 *
 * The failure that matters is not missing a disagreement. It is
 * INVENTING one: matching two different people, or reporting a
 * formatting difference as a contradiction. A drift report with one
 * fictional row in it gets dismissed entirely, and correctly.
 */

export {};

import {
  compareRecordSets,
  matchKey,
  renderDrift,
  sameValue,
} from "../cross-source-drift";

describe("matching is conservative on purpose", () => {
  it("matches on email regardless of case", () => {
    expect(matchKey({ Email: "Jo@Acme.com" })).toBe(matchKey({ email: "jo@acme.com" }));
  });

  it("falls back to a two-part name", () => {
    expect(matchKey({ firstName: "Jo", lastName: "Bell" })).toBe(
      matchKey({ name: "  Jo   Bell " }),
    );
  });

  it("refuses to match on a single word", () => {
    /* Every record called "Admin" matching every other one produces a
       spectacular and entirely fictional drift report. */
    expect(matchKey({ name: "Admin" })).toBeNull();
    expect(matchKey({ firstName: "Jo" })).toBeNull();
  });

  it("prefers email over name when both are present", () => {
    const a = matchKey({ email: "jo@acme.com", name: "Jo Bell" });
    const b = matchKey({ email: "jo@acme.com", name: "Josephine Bell-Smith" });
    expect(a).toBe(b);
  });
});

describe("formatting is not disagreement", () => {
  it.each([
    ["Acme Ltd", "acme ltd"],
    ["  spaced  ", "spaced"],
    [1000, "1,000"],
    ["$1,000", 1000],
    [null, ""],
    [undefined, null],
  ])("treats %p and %p as the same answer", (a, b) => {
    expect(sameValue(a, b)).toBe(true);
  });

  it("still catches a real difference", () => {
    expect(sameValue("Acme Ltd", "Acme Limited")).toBe(false);
    expect(sameValue(1000, 1001)).toBe(false);
  });
});

describe("the report", () => {
  const HUBSPOT = [
    { email: "jo@acme.com", phone: "0161 555 0101", owner: "Dana", stage: "Customer" },
    { email: "sam@acme.com", phone: "0161 555 0102", owner: "Dana", stage: "Lead" },
    { email: "kim@beta.com", phone: "0161 555 0103", owner: "Ray", stage: "Customer" },
    { name: "Admin" },
  ];
  const DMS = [
    { email: "JO@ACME.COM", phone: "0161 555 9999", owner: "Dana", stage: "customer" },
    { email: "sam@acme.com", phone: "0161 555 0102", owner: "Ray", stage: "Lead" },
    { email: "lee@gamma.com", phone: "0161 555 0104", owner: "Ray", stage: "Lead" },
  ];

  const report = compareRecordSets(
    "contact",
    { name: "hubspot", records: HUBSPOT },
    { name: "legacy-dms", records: DMS },
  );

  it("counts only records it genuinely matched", () => {
    expect(report.matched).toBe(2);
    expect(report.onlyInLeft).toBe(1);
    expect(report.onlyInRight).toBe(1);
  });

  it("reports what it could not line up rather than hiding it", () => {
    /* The single-word "Admin" record. Excluding it silently would make
       the comparison look cleaner than it is. */
    expect(report.unmatchable).toBe(1);
  });

  it("ranks the fields that actually disagree", () => {
    const fields = report.fields.map((f) => f.field);
    expect(fields).toContain("phone");
    expect(fields).toContain("owner");
    /* stage differs only by case between Customer and customer. */
    expect(fields).not.toContain("stage");
  });

  it("carries one example so the reader can go and check it", () => {
    const phone = report.fields.find((f) => f.field === "phone")!;
    expect(phone.example).toMatchObject({
      left: "0161 555 0101",
      right: "0161 555 9999",
    });
  });

  it("ignores fields that are supposed to differ between systems", () => {
    const r = compareRecordSets(
      "contact",
      { name: "a", records: [{ email: "x@y.com", id: "1", updated_at: "2026-01-01" }] },
      { name: "b", records: [{ email: "x@y.com", id: "99", updated_at: "2026-08-01" }] },
    );
    expect(r.fields).toEqual([]);
  });

  it("does not treat a field only one system holds as a contradiction", () => {
    /* A schema difference is not a disagreement. Reporting it as one
       would bury the real drift under every column HubSpot happens to
       have and the DMS does not. */
    const r = compareRecordSets(
      "contact",
      { name: "a", records: [{ email: "x@y.com", lifecycle: "customer" }] },
      { name: "b", records: [{ email: "x@y.com" }] },
    );
    expect(r.fields).toEqual([]);
    expect(r.matched).toBe(1);
  });

  it("does not let a duplicate inside one system look like drift", () => {
    /* Two rows for the same person in ONE system is a real problem and
       a different one. Conflating them reports a system as
       disagreeing with itself. */
    const r = compareRecordSets(
      "contact",
      { name: "a", records: [{ email: "x@y.com", owner: "Dana" }, { email: "x@y.com", owner: "Ray" }] },
      { name: "b", records: [{ email: "x@y.com", owner: "Dana" }] },
    );
    expect(r.matched).toBe(1);
    expect(r.fields).toEqual([]);
  });
});

describe("how it reads", () => {
  it("says plainly when nothing could be matched", () => {
    const r = compareRecordSets(
      "contact",
      { name: "a", records: [{ email: "one@x.com" }] },
      { name: "b", records: [{ email: "two@x.com" }] },
    );
    expect(renderDrift(r)).toContain("could be matched");
  });

  it("says so when two systems agree everywhere they overlap", () => {
    const r = compareRecordSets(
      "contact",
      { name: "a", records: [{ email: "x@y.com", owner: "Dana" }] },
      { name: "b", records: [{ email: "x@y.com", owner: "dana" }] },
    );
    expect(renderDrift(r)).toContain("agree everywhere they overlap");
  });

  it("leads with the disagreements and gives the share, not just the count", () => {
    const r = compareRecordSets(
      "contact",
      { name: "hubspot", records: [{ email: "x@y.com", owner: "Dana" }] },
      { name: "dms", records: [{ email: "x@y.com", owner: "Ray" }] },
    );
    const out = renderDrift(r);
    expect(out).toMatch(/`owner`: 1 of 1 disagree \(100%\)/);
    expect(out).toContain('hubspot says "Dana"');
  });
});
