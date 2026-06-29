/**
 * Shape guard for 205_cross_scan_insights.sql (offline; no DB).
 *
 * Asserts the cross-scan insights ledger is created with a TEXT opaque id
 * (schema-guard parity), the kind/severity/platform/narrative/status columns,
 * modalities + members as JSONB, a UNIQUE index on `key` (the dedup guard the
 * store's ON CONFLICT (key) needs), the generated_at index, RLS enabled with a
 * permissive policy (the deny-by-default tripwire), idempotency (IF NOT EXISTS
 * guards), and a paired reversible .down.sql.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "205_cross_scan_insights.sql");
const DOWN = path.resolve(__dirname, "..", "205_cross_scan_insights.down.sql");

describe("205_cross_scan_insights.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_cross_scan_insights idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_cross_scan_insights/i);
  });

  test("id is TEXT primary key (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).not.toMatch(/\bid\s+UUID/i);
  });

  test("has the kind / severity / platform / narrative / status columns", () => {
    expect(sql).toMatch(/generated_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/platform\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/kind\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/severity\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/narrative\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/status\s+TEXT\s+NOT NULL DEFAULT 'open'/i);
    expect(sql).toMatch(/key\s+TEXT\s+NOT NULL/i);
  });

  test("modalities + members are JSONB", () => {
    expect(sql).toMatch(/modalities\s+JSONB\s+NOT NULL/i);
    expect(sql).toMatch(/members\s+JSONB\s+NOT NULL/i);
  });

  test("a UNIQUE index on key guards dedup (ON CONFLICT (key))", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_key\s+ON instinct_cross_scan_insights \(key\)/i,
    );
  });

  test("indexes generated_at for the newest-first dashboard read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_cross_scan_insights_generated_at\s+ON instinct_cross_scan_insights \(generated_at DESC\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE instinct_cross_scan_insights ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY instinct_cross_scan_insights_all ON instinct_cross_scan_insights\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_cross_scan_insights/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_cross_scan_insights_key/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_cross_scan_insights_generated_at/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_cross_scan_insights_all/i);
  });
});
