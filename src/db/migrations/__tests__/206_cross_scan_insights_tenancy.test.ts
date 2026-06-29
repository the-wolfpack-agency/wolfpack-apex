/**
 * Shape guard for 206_cross_scan_insights_tenancy.sql (offline; no DB).
 *
 * 206 closes a cross-tenant leak (FIX 2): migration 205 keyed dedup on `key`
 * alone, with no tenant, so workspace B overwrote workspace A and the unfiltered
 * read served it cross-tenant. This test asserts 206 is ADDITIVE (it does not edit
 * 205), adds workspace_id, replaces the single-column UNIQUE(key) with a composite
 * UNIQUE(workspace_id, key) - dropping the old one - indexes workspace_id, is
 * idempotent (guarded), and has a paired reversible .down.sql.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "206_cross_scan_insights_tenancy.sql");
const DOWN = path.resolve(__dirname, "..", "206_cross_scan_insights_tenancy.down.sql");
const M205 = path.resolve(__dirname, "..", "205_cross_scan_insights.sql");

describe("206_cross_scan_insights_tenancy.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("adds workspace_id additively (ADD COLUMN IF NOT EXISTS, no backfill needed)", () => {
    expect(sql).toMatch(
      /ALTER TABLE instinct_cross_scan_insights\s+ADD COLUMN IF NOT EXISTS workspace_id TEXT/i,
    );
  });

  test("does NOT recreate or alter the table itself (additive to 205, never edits it)", () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  test("drops the old single-column key dedup guard (index AND/OR constraint)", () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS idx_cross_scan_insights_key/i);
    // Defensive: also guards a constraint shape.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS/i);
  });

  test("adds a composite UNIQUE(workspace_id, key) - the tenant-scoped dedup guard", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_ws_key\s+ON instinct_cross_scan_insights \(workspace_id, key\)/i,
    );
  });

  test("indexes workspace_id for the tenant-scoped dashboard read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_cross_scan_insights_workspace\s+ON instinct_cross_scan_insights \(workspace_id\)/i,
    );
  });

  test("is idempotent (IF NOT EXISTS / IF EXISTS guards throughout)", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(sql).toMatch(/DROP INDEX IF EXISTS/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/i);
  });

  test("re-asserts RLS is still enabled (the 205 tripwire is not weakened)", () => {
    expect(sql).toMatch(/relrowsecurity = true/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'RLS not enabled/i);
  });

  test("guards the composite index exists and the old single-column index is gone", () => {
    expect(sql).toMatch(/idx_cross_scan_insights_ws_key/);
    expect(sql).toMatch(/ASSERT[\s\S]*idx_cross_scan_insights_key[\s\S]*\) = 0/i);
  });

  test("has a paired reversible down migration that restores the 205 shape", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_cross_scan_insights_ws_key/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_cross_scan_insights_workspace/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS workspace_id/i);
    // Restores the 205 single-column key index.
    expect(down).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_key\s+ON instinct_cross_scan_insights \(key\)/i,
    );
  });

  test("205 is left untouched (still the single-column key index source of truth)", () => {
    const m205 = fs.readFileSync(M205, "utf-8");
    expect(m205).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_key/i);
    // 205 must NOT have learned about workspace_id (proof we added 206, not edited 205).
    expect(m205).not.toMatch(/workspace_id/i);
  });
});
