/**
 * The one mistake this cannot make.
 *
 * Telling a client a column is unused when something reads it is
 * unrecoverable: they check one, find it wrong, and correctly stop
 * believing the rest of the report. Missing a genuinely dark column
 * costs nothing, because they never knew about it anyway.
 *
 * So most of this suite is about staying quiet.
 */

export {};

import { findDarkData, renderDarkData, MOSTLY_NULL } from "../dark-data";
import type { LegacyScan } from "@/lib/sources/legacy-postgres";

function scan(
  columns: Array<[string, string, number | null, string?]>,
  shapes: string[],
): LegacyScan {
  return {
    tables: [],
    columns: columns.map(([table, column, nullFraction, dataType]) => ({
      table,
      column,
      dataType: dataType ?? "text",
      nullFraction,
    })),
    shapes: shapes.map((shape, i) => ({ shape, calls: 100 + i, totalMs: 1000 })),
    statementStatsAvailable: true,
  };
}

describe("it stays quiet unless it is sure", () => {
  it("counts a column as used if any statement names it, even against another table", () => {
    /* Cheap to over-count usage. Expensive to invent a dark column. */
    const s = scan(
      [["customers", "loyalty_tier", 0.1]],
      ["SELECT loyalty_tier FROM orders WHERE id = $1"],
    );
    expect(findDarkData(s).dark).toEqual([]);
  });

  it("excludes a whole table when anything reads it with SELECT *", () => {
    /* Star-select means the statement text cannot say which columns
       were read, so nothing about that table is knowable this way. */
    const s = scan(
      [
        ["customers", "loyalty_tier", 0.1],
        ["orders", "referral_code", 0.2],
      ],
      ["SELECT * FROM customers WHERE id = $1", "SELECT total FROM orders"],
    );
    const r = findDarkData(s);
    expect(r.starSelectTables).toEqual(["customers"]);
    expect(r.dark.map((c) => c.column)).toEqual(["referral_code"]);
  });

  it("does not claim a column is dark when the table has never been analysed", () => {
    /* No planner sample means no evidence it holds anything, and the
       whole claim is "there is DATA in here nobody reads". */
    const s = scan([["customers", "loyalty_tier", null]], ["SELECT name FROM customers"]);
    const r = findDarkData(s);
    expect(r.dark).toEqual([]);
    expect(r.unanalysed).toBe(1);
  });

  it("ignores a column that is almost entirely null", () => {
    const s = scan([["customers", "loyalty_tier", MOSTLY_NULL + 0.01]], ["SELECT name FROM customers"]);
    expect(findDarkData(s).dark).toEqual([]);
  });

  it("ignores structural columns nobody names explicitly", () => {
    /* A dark primary key is not a discovery, it is noise that buries
       the real finding. */
    const s = scan(
      [
        ["customers", "id", 0],
        ["customers", "created_at", 0],
        ["customers", "loyalty_tier", 0.1],
      ],
      ["SELECT name FROM customers"],
    );
    expect(findDarkData(s).dark.map((c) => c.column)).toEqual(["loyalty_tier"]);
  });

  it("does not judge a name too short to match on safely", () => {
    /* A three-letter column that never appears is far more likely to
       be a matching artefact than a discovery. */
    const s = scan([["customers", "vin", 0.1]], ["SELECT name FROM customers"]);
    expect(findDarkData(s).dark).toEqual([]);
  });

  it("matches on whole words, so referral_code is not covered by code", () => {
    const s = scan(
      [["orders", "referral_code", 0.2]],
      ["SELECT code FROM lookup WHERE code = $1"],
    );
    expect(findDarkData(s).dark.map((c) => c.column)).toEqual(["referral_code"]);
  });

  it("treats a column named inside a longer identifier as used", () => {
    /* order_notes appearing as o.order_notes is the same column. */
    const s = scan(
      [["orders", "order_notes", 0.3]],
      ["SELECT o.order_notes FROM orders o WHERE o.id = $1"],
    );
    expect(findDarkData(s).dark).toEqual([]);
  });
});

describe("what it does report", () => {
  const s = scan(
    [
      ["customers", "loyalty_tier", 0.05, "character varying"],
      ["customers", "referral_source", 0.4, "text"],
      ["customers", "name", 0.0],
      ["orders", "delivery_window", 0.6, "tstzrange"],
    ],
    [
      "SELECT name FROM customers WHERE id = $1",
      "UPDATE customers SET name = $1 WHERE id = $2",
      "SELECT total FROM orders WHERE id = $1",
    ],
  );
  const r = findDarkData(s);

  it("finds the populated columns nothing names", () => {
    expect(r.dark.map((c) => c.column)).toEqual([
      "loyalty_tier",
      "referral_source",
      "delivery_window",
    ]);
  });

  it("ranks the fullest column first, because it is the strongest evidence", () => {
    expect(r.dark[0]).toMatchObject({ column: "loyalty_tier", populated: 0.95 });
  });

  it("carries the type, so a reader can tell what they are looking at", () => {
    expect(r.dark[0].dataType).toBe("character varying");
  });

  it("says how many statements the conclusion rests on", () => {
    expect(r.statementsExamined).toBe(3);
  });
});

describe("how it is said", () => {
  it("never claims a column is unused, only that no statement names it", () => {
    /* A query that ran before the statistics window would not appear
       here. Overclaiming is how a real finding gets dismissed. */
    const out = renderDarkData(
      findDarkData(scan([["customers", "loyalty_tier", 0.1]], ["SELECT name FROM customers"])),
      "the DMS",
    );
    expect(out).toContain('not "these are unused"');
    expect(out).not.toMatch(/\bthese columns are unused\b/i);
  });

  it("declares what it had to exclude rather than quietly dropping it", () => {
    const s = scan(
      [
        ["customers", "loyalty_tier", 0.1],
        ["legacy_audit", "actor_name", null],
        ["orders", "referral_code", 0.2],
      ],
      ["SELECT * FROM orders", "SELECT name FROM customers"],
    );
    const out = renderDarkData(findDarkData(s), "the DMS");
    expect(out).toContain("SELECT *");
    expect(out).toContain("never sampled");
  });

  it("says plainly when there is no statement history to compare against", () => {
    const out = renderDarkData(findDarkData(scan([["a", "colname", 0.1]], [])), "the DMS");
    expect(out).toContain("No statement history");
  });

  it("says so when every populated column is accounted for", () => {
    const s = scan([["customers", "full_name", 0.1]], ["SELECT full_name FROM customers"]);
    expect(renderDarkData(findDarkData(s), "the DMS")).toContain("is named by at least one statement");
  });
});
