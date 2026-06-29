/**
 * Shape guard for 208_tenant_isolation_scans.sql (offline; no DB).
 *
 * Asserts the tenant-isolation coverage ledger is created with a TEXT opaque id
 * (schema-guard parity, never UUID), INT scoped_tables / total_offenders /
 * unclassified, a JSONB counts column, an observed_at default-NOW timestamp, the
 * observed_at index, RLS enabled with a permissive policy (deny-by-default
 * tripwire), idempotency (IF NOT EXISTS guards), and a paired reversible
 * .down.sql. The table is codebase-wide metric data — NOT workspace-scoped.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "208_tenant_isolation_scans.sql");
const DOWN = path.resolve(__dirname, "..", "208_tenant_isolation_scans.down.sql");

describe("208_tenant_isolation_scans.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_tenant_isolation_scans idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_tenant_isolation_scans/i);
  });

  test("id is TEXT primary key (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).not.toMatch(/\bid\s+UUID/i);
  });

  test("is NOT workspace-scoped (codebase metric, no workspace_id column)", () => {
    // Strip `-- ...` comments: the header explains WHY there's no workspace_id
    // column, so we assert about executable SQL, not prose.
    const executable = sql.replace(/--[^\n]*/g, "");
    expect(executable).not.toMatch(/\bworkspace_id\b/i);
  });

  test("has the metric columns (INT counts, JSONB breakdown, NOW timestamp)", () => {
    expect(sql).toMatch(/scoped_tables\s+INT\s+NOT NULL/i);
    expect(sql).toMatch(/total_offenders\s+INT\s+NOT NULL/i);
    expect(sql).toMatch(/unclassified\s+INT\s+NOT NULL/i);
    expect(sql).toMatch(/counts\s+JSONB\s+NOT NULL/i);
    expect(sql).toMatch(/observed_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
  });

  test("indexes observed_at for the trend read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_tenant_isolation_scans_observed_at\s+ON instinct_tenant_isolation_scans \(observed_at DESC\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE instinct_tenant_isolation_scans ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY instinct_tenant_isolation_scans_all ON instinct_tenant_isolation_scans\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT id, INT unclassified, RLS on)", () => {
    expect(sql).toMatch(/id must be TEXT/i);
    expect(sql).toMatch(/unclassified must be INT/i);
    expect(sql).toMatch(/RLS not enabled on instinct_tenant_isolation_scans/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_tenant_isolation_scans/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_tenant_isolation_scans_observed_at/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_tenant_isolation_scans_all/i);
  });
});
