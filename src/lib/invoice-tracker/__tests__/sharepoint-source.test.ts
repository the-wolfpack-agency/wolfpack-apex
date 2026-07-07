/**
 * Pure-function tests for the generic workbook parser + share-URL encoder.
 * The Graph I/O in fetchSheet is exercised via the resolver + route tests with
 * mocks; here we lock the parsing contract that the whole mirror depends on.
 */
import { encodeShareUrl, parseSheet } from "../sharepoint-source";

describe("encodeShareUrl", () => {
  it("produces Graph's u! base64url form (no padding, URL-safe alphabet)", () => {
    const enc = encodeShareUrl("https://host/:x:/s/Site/AbC+d/e?e=1");
    expect(enc.startsWith("u!")).toBe(true);
    expect(enc).not.toMatch(/=/);
    expect(enc).not.toMatch(/\+/);
    expect(enc).not.toMatch(/\//);
    // Round-trips back to the original URL when decoded.
    const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(
      "https://host/:x:/s/Site/AbC+d/e?e=1",
    );
  });
});

describe("parseSheet", () => {
  it("uses the header row to name columns and returns row objects", () => {
    const { columns, rows } = parseSheet([
      ["Company", "Invoice", "Amount"],
      ["PCNA", "INV-1", "1000"],
      ["PCNA", "INV-2", "2500"],
    ]);
    expect(columns).toEqual(["Company", "Invoice", "Amount"]);
    expect(rows).toEqual([
      { Company: "PCNA", Invoice: "INV-1", Amount: "1000" },
      { Company: "PCNA", Invoice: "INV-2", Amount: "2500" },
    ]);
  });

  it("coerces numbers/booleans to trimmed strings", () => {
    const { rows } = parseSheet([
      ["N", "Flag"],
      [1000, true],
    ]);
    expect(rows[0]).toEqual({ N: "1000", Flag: "true" });
  });

  it("drops fully-empty rows but keeps partially-filled ones", () => {
    const { rows } = parseSheet([
      ["A", "B"],
      ["", ""],
      [null, null],
      ["x", ""],
    ]);
    expect(rows).toEqual([{ A: "x", B: "" }]);
  });

  it("ignores blank header cells and de-dupes repeated headers", () => {
    const { columns } = parseSheet([
      ["A", "", "A", "B"],
      ["1", "2", "3", "4"],
    ]);
    expect(columns).toEqual(["A", "B"]);
  });

  it("forward-fills section-header columns", () => {
    const { rows } = parseSheet(
      [
        ["Section", "Item"],
        ["Design", "Logo"],
        ["", "Brand book"],
        ["Build", "Homepage"],
        ["", "Checkout"],
      ],
      ["Section"],
    );
    expect(rows.map((r) => r.Section)).toEqual(["Design", "Design", "Build", "Build"]);
  });

  it("returns empty columns/rows for an empty sheet or a header-only sheet", () => {
    expect(parseSheet([])).toEqual({ columns: [], rows: [] });
    expect(parseSheet([["A", "B"]])).toEqual({ columns: ["A", "B"], rows: [] });
    expect(parseSheet([["", ""]])).toEqual({ columns: [], rows: [] });
  });
});
