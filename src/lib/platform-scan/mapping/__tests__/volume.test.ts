/**
 * How much a system holds, and whether it can be moved.
 *
 * Scoping a rollout needs both, and the walk was leaving them to somebody
 * opening every screen by hand.
 */
import { readVolume, findExports, describeExports } from "../volume";

describe("reading how much a system holds", () => {
  /* A pager states the estate; a bare number beside a noun may be the page. */
  it("prefers a pager, because it states the total rather than the page", () => {
    expect(readVolume(["1-25 of 347", "25 entries"])).toEqual({
      total: 347,
      from: "1-25 of 347",
    });
  });

  it("reads a plain total", () => {
    expect(readVolume(["1,284 submissions"]).total).toBe(1284);
  });

  it("handles the dash a system happens to use", () => {
    expect(readVolume(["1 to 50 of 1,000"]).total).toBe(1000);
    expect(readVolume(["1 – 50 of 900"]).total).toBe(900);
  });

  /* NO COUNT IS NOT ZERO. "This object holds nothing" and "this screen did
     not say" are opposite facts, and a migration plan built on the wrong one
     is wrong by the whole object. */
  it("says nothing rather than zero when no quantity was stated", () => {
    expect(readVolume([])).toEqual({ total: null, from: null });
    expect(readVolume(["no results"]).total).toBeNull();
  });

  /* Understating volume is what produces an estimate somebody has to
     renegotiate. */
  it("takes the largest stated quantity when there is no pager", () => {
    expect(readVolume(["12 items", "4,000 records"]).total).toBe(4000);
  });

  /* A reviewer can check rather than trust. */
  it("keeps the phrase the number came from", () => {
    expect(readVolume(["347 entries"]).from).toBe("347 entries");
  });
});

describe("finding a way data could leave", () => {
  it("recognizes an export control", () => {
    const out = findExports(["Export to CSV", "Save"]);
    expect(out).toEqual([{ kind: "download", label: "Export to CSV" }]);
  });

  /* DELIBERATELY NARROW. A looser rule matches "save" and "send", which are
     writes, and reporting a send button as an export route would describe a
     way data leaves that nobody asked for. */
  it("does not mistake a write for an export", () => {
    expect(findExports(["Save", "Send to client", "Submit", "Share"])).toEqual([]);
  });

  it("recognizes an API or webhook surface", () => {
    expect(findExports(["Developer settings"])[0].kind).toBe("api");
  });

  /* A query string can carry a record id, and a stored map has no business
     holding one. */
  it("reads a link's path and never its query string", () => {
    const out = findExports([], ["https://app.example/reports/export.csv?recordId=abc123"]);
    expect(out).toHaveLength(1);
    expect(out[0].label).not.toContain("abc123");
  });

  it("does not repeat the same affordance", () => {
    expect(findExports(["Export", "export", "Export"])).toHaveLength(1);
  });

  /* Absence of evidence, said as such. */
  it("does not claim a system cannot export just because none was seen", () => {
    const text = describeExports([]);
    expect(text).toMatch(/not the same as there being none/i);
  });

  /* Detected, not tested: clicking would download somebody's data onto our
     machine, which is the one thing a read-only scan must not do. */
  it("says it detected rather than tested", () => {
    expect(describeExports([{ kind: "download", label: "Export" }])).toMatch(
      /nothing was downloaded/i,
    );
  });
});
