/**
 * Structural invariant test for migration 052 — apex_benefit_plans rename.
 *
 * Reads the migration .sql and .down.sql files raw from disk and asserts
 * that the migration follows the Tier-4 safety contract:
 *   - Forward + down files both exist
 *   - Forward file names the OLD table (source of RENAME) and the NEW
 *     table (target)
 *   - Forward file has a DO $$ ... END $$ defensive block
 *   - Forward file CREATEs a backward-compat view named apex_benefit_plans
 *   - Forward file has a row-count assertion
 *   - Down file reverses the rename
 *
 * This is a structural contract test — cannot be mocked around, cannot
 * silently drift. If a future refactor strips out the compat-view
 * guarantee or the row-count assertion, this test fails loudly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const FORWARD = path.join(MIGRATIONS_DIR, "052_rename_benefit_plans.sql");
const DOWN = path.join(MIGRATIONS_DIR, "052_rename_benefit_plans.down.sql");

describe("migration 052 — structural invariants", () => {
  let forwardSql: string;
  let downSql: string;

  beforeAll(() => {
    forwardSql = fs.readFileSync(FORWARD, "utf8");
    downSql = fs.readFileSync(DOWN, "utf8");
  });

  it("forward migration file exists", () => {
    expect(fs.existsSync(FORWARD)).toBe(true);
    expect(forwardSql.length).toBeGreaterThan(0);
  });

  it("down migration file exists (paired rollback)", () => {
    expect(fs.existsSync(DOWN)).toBe(true);
    expect(downSql.length).toBeGreaterThan(0);
  });

  it("forward references the OLD table name (rename FROM)", () => {
    expect(forwardSql).toMatch(/apex_benefit_plans/);
  });

  it("forward references the NEW table name (rename TO)", () => {
    expect(forwardSql).toMatch(/instinct_benefit_plans/);
  });

  it("forward has a DO $$ ... END $$ defensive block", () => {
    // At least one DO block for the defensive rename logic.
    expect(forwardSql).toMatch(/DO \$\$/);
    expect(forwardSql).toMatch(/END \$\$/);
  });

  it("forward performs an ALTER TABLE ... RENAME TO", () => {
    expect(forwardSql).toMatch(/ALTER TABLE[^;]*apex_benefit_plans[^;]*RENAME TO[^;]*instinct_benefit_plans/);
  });

  it("forward creates the backward-compat view apex_benefit_plans", () => {
    // Must CREATE OR REPLACE VIEW apex_benefit_plans pointing at the new table.
    expect(forwardSql).toMatch(/CREATE OR REPLACE VIEW apex_benefit_plans AS SELECT \* FROM instinct_benefit_plans/);
  });

  it("forward has a row-count assertion", () => {
    // Either a NOTICE or an EXCEPTION referencing the row-count check.
    expect(forwardSql).toMatch(/pre_rename_count/);
    expect(forwardSql).toMatch(/post_rename_count/);
    expect(forwardSql).toMatch(/Row-count/);
  });

  it("forward asserts the compat view is updatable+insertable", () => {
    expect(forwardSql).toMatch(/is_updatable/);
    expect(forwardSql).toMatch(/is_insertable/);
  });

  it("down reverses the rename (instinct → apex)", () => {
    expect(downSql).toMatch(/ALTER TABLE IF EXISTS instinct_benefit_plans RENAME TO apex_benefit_plans/);
  });

  it("down drops the apex_* compat view first", () => {
    expect(downSql).toMatch(/DROP VIEW IF EXISTS apex_benefit_plans/);
  });

  it("down restores the migration-014 alias view", () => {
    expect(downSql).toMatch(/CREATE OR REPLACE VIEW instinct_benefit_plans AS\s+SELECT \* FROM apex_benefit_plans/);
  });
});
