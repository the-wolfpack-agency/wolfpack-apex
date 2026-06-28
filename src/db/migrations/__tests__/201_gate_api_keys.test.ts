/**
 * Shape guard for 201_gate_api_keys.sql (offline; no DB).
 *
 * Asserts the table is created with TEXT opaque-id columns (schema-guard
 * parity), the prefix + workspace indexes exist, RLS is enabled with a
 * permissive policy (the deny-by-default tripwire), the migration is idempotent
 * (IF NOT EXISTS guards), and a paired reversible .down.sql exists. The
 * standalone workspace-id-type / user-id-columns schema guards cover the column
 * types across all migrations; this test pins THIS migration's contract.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "201_gate_api_keys.sql");
const DOWN = path.resolve(__dirname, "..", "201_gate_api_keys.down.sql");

describe("201_gate_api_keys.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_gate_api_keys idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_gate_api_keys/i);
  });

  test("opaque-id columns are TEXT (schema-guard parity)", () => {
    expect(sql).toMatch(/\bid\s+TEXT PRIMARY KEY/i);
    expect(sql).toMatch(/workspace_id\s+TEXT NOT NULL/i);
    expect(sql).toMatch(/agent\s+TEXT NOT NULL/i);
    expect(sql).toMatch(/created_by\s+TEXT/i);
    // No UUID / BIGINT on the id-bearing columns.
    expect(sql).not.toMatch(/workspace_id\s+UUID/i);
    expect(sql).not.toMatch(/\bid\s+UUID/i);
  });

  test("stores the hash + prefix + last4, with capabilities as TEXT[]", () => {
    expect(sql).toMatch(/key_hash\s+TEXT NOT NULL/i);
    expect(sql).toMatch(/key_prefix\s+TEXT NOT NULL/i);
    expect(sql).toMatch(/last4\s+TEXT/i);
    expect(sql).toMatch(/capabilities\s+TEXT\[\]\s+NOT NULL DEFAULT '\{\}'/i);
    expect(sql).toMatch(/revoked_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/last_used_at\s+TIMESTAMPTZ/i);
  });

  test("indexes prefix (lookup) and workspace_id", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_gate_api_keys_prefix\s+ON instinct_gate_api_keys \(key_prefix\)/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_gate_api_keys_workspace\s+ON instinct_gate_api_keys \(workspace_id\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(
      /ALTER TABLE instinct_gate_api_keys ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY instinct_gate_api_keys_all ON instinct_gate_api_keys\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_gate_api_keys/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_gate_api_keys_prefix/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_gate_api_keys_all/i);
  });
});
