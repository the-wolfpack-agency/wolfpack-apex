/**
 * Shape guard for 204_competitor_benchmark_runs.sql (offline; no DB).
 *
 * Asserts the competitive benchmark ledger is created with a TEXT opaque id
 * (schema-guard parity), the tool/target keys + metric columns, report as JSONB,
 * the run_at index, RLS enabled with a permissive policy (the deny-by-default
 * tripwire), idempotency (IF NOT EXISTS guards), and a paired reversible
 * .down.sql. Mirrors 203_benchmark_runs.test.ts.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "204_competitor_benchmark_runs.sql");
const DOWN = path.resolve(__dirname, "..", "204_competitor_benchmark_runs.down.sql");

describe("204_competitor_benchmark_runs.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_competitor_benchmark_runs idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_competitor_benchmark_runs/i);
  });

  test("id is TEXT primary key (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).not.toMatch(/\bid\s+UUID/i);
  });

  test("has the tool/target keys + metric columns", () => {
    expect(sql).toMatch(/run_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/tool\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/target\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/recall\s+NUMERIC\s+NOT NULL/i);
    expect(sql).toMatch(/precision\s+NUMERIC\s+NOT NULL/i);
    expect(sql).toMatch(/findings\s+INTEGER\s+NOT NULL/i);
  });

  test("report is JSONB", () => {
    expect(sql).toMatch(/report\s+JSONB\s+NOT NULL/i);
  });

  test("indexes run_at for the newest-first dashboard read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_competitor_runs_run_at\s+ON instinct_competitor_benchmark_runs \(run_at DESC\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(
      /ALTER TABLE instinct_competitor_benchmark_runs ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY instinct_competitor_benchmark_runs_all ON instinct_competitor_benchmark_runs\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_competitor_benchmark_runs/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_competitor_runs_run_at/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_competitor_benchmark_runs_all/i);
  });
});
