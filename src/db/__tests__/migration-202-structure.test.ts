/** Structural invariant test for 202_gate_rate_limits.sql.
 *
 * 202 adds instinct_gate_rate_limits: the per-API-key fixed-window rate-limit
 * counter behind the bring-your-own-agent gate (POST /api/gate/authorize). It
 * must:
 *   - create the table idempotently (CREATE TABLE IF NOT EXISTS),
 *   - key on (key_id, window_start) with TEXT key_id (schema-guard parity),
 *   - enable RLS with a permissive deny-by-default policy (migration 196 idiom),
 *   - be transactional + additive,
 *   - and the paired .down.sql drops the table/index/policy.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "202_gate_rate_limits.sql"), "utf-8");
const DOWN_PATH = join(DIR, "202_gate_rate_limits.down.sql");

describe("migration 202 up", () => {
  it("creates instinct_gate_rate_limits idempotently", () => {
    expect(UP).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_gate_rate_limits/,
    );
  });

  it("keys on (key_id, window_start) with a TEXT key_id (schema-guard parity)", () => {
    expect(UP).toMatch(/key_id\s+TEXT/);
    expect(UP).toMatch(/window_start\s+TIMESTAMPTZ/);
    expect(UP).toMatch(/count\s+INTEGER/);
    expect(UP).toMatch(/PRIMARY KEY \(key_id, window_start\)/);
    // Explicit guard: key_id is TEXT, never UUID (mirrors the sweep-runs guard).
    expect(UP).toMatch(/key_id must be TEXT/);
    expect(UP).not.toMatch(/key_id\s+UUID/i);
  });

  it("enables RLS with a permissive deny-by-default policy", () => {
    expect(UP).toMatch(
      /ALTER TABLE instinct_gate_rate_limits ENABLE ROW LEVEL SECURITY/,
    );
    expect(UP).toMatch(
      /CREATE POLICY instinct_gate_rate_limits_all ON instinct_gate_rate_limits/,
    );
    expect(UP).toMatch(/USING \(true\) WITH CHECK \(true\)/);
  });

  it("guards its index with IF NOT EXISTS", () => {
    expect(UP).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it("is additive + transactional (no drops/deletes; BEGIN/COMMIT)", () => {
    expect(UP).toMatch(/BEGIN;/);
    expect(UP).toMatch(/COMMIT;/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DROP COLUMN/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
  });
});

describe("migration 202 down", () => {
  it("exists and drops the table, index, and policy idempotently", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_gate_rate_limits/);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_gate_rate_limits_window/);
    expect(down).toMatch(
      /DROP POLICY IF EXISTS instinct_gate_rate_limits_all/,
    );
  });
});
