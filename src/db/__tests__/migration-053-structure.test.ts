/**
 * Structural invariant test for migration 053 — apex_benefit_recommendations rename.
 * See migration-052-structure.test.ts for the rationale. Same contract,
 * different table.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const FORWARD = path.join(MIGRATIONS_DIR, "053_rename_benefit_recommendations.sql");
const DOWN = path.join(MIGRATIONS_DIR, "053_rename_benefit_recommendations.down.sql");

describe("migration 053 — structural invariants", () => {
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
    expect(forwardSql).toMatch(/apex_benefit_recommendations/);
  });

  it("forward references the NEW table name (rename TO)", () => {
    expect(forwardSql).toMatch(/instinct_benefit_recommendations/);
  });

  it("forward has a DO $$ ... END $$ defensive block", () => {
    expect(forwardSql).toMatch(/DO \$\$/);
    expect(forwardSql).toMatch(/END \$\$/);
  });

  it("forward performs an ALTER TABLE ... RENAME TO", () => {
    expect(forwardSql).toMatch(/ALTER TABLE[^;]*apex_benefit_recommendations[^;]*RENAME TO[^;]*instinct_benefit_recommendations/);
  });

  it("forward creates the backward-compat view apex_benefit_recommendations", () => {
    expect(forwardSql).toMatch(/CREATE OR REPLACE VIEW apex_benefit_recommendations AS SELECT \* FROM instinct_benefit_recommendations/);
  });

  it("forward has a row-count assertion", () => {
    expect(forwardSql).toMatch(/pre_rename_count/);
    expect(forwardSql).toMatch(/post_rename_count/);
    expect(forwardSql).toMatch(/Row-count/);
  });

  it("forward asserts the compat view is updatable+insertable", () => {
    expect(forwardSql).toMatch(/is_updatable/);
    expect(forwardSql).toMatch(/is_insertable/);
  });

  it("down reverses the rename (instinct → apex)", () => {
    expect(downSql).toMatch(/ALTER TABLE IF EXISTS instinct_benefit_recommendations[\s\S]*RENAME TO apex_benefit_recommendations/);
  });

  it("down drops the apex_* compat view first", () => {
    expect(downSql).toMatch(/DROP VIEW IF EXISTS apex_benefit_recommendations/);
  });

  it("down restores the migration-014 alias view", () => {
    expect(downSql).toMatch(/CREATE OR REPLACE VIEW instinct_benefit_recommendations AS\s+SELECT \* FROM apex_benefit_recommendations/);
  });
});
