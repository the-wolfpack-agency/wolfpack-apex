/**
 * Structural invariant test for 169_ogiam_decisions.sql.
 *
 * Locks the shape of the OGIAM decision ledger:
 *   - CREATE TABLE IF NOT EXISTS ogiam_decisions (additive, idempotent, no
 *     destructive statements in the up migration).
 *   - The hash-chain columns (prev_hash, entry_hash) and the would_block metric
 *     exist, and the per-workspace chain is guarded by UNIQUE (workspace_id, seq).
 *   - The reserved signature column exists for the enforce-phase signing.
 *   - The paired .down.sql drops the table (the ledger is an evidence stream,
 *     not a source of truth, so a rollback losing recorded decisions is
 *     acceptable).
 *
 * Full DB execution is exercised by the deploy-time migrate run
 * (npm run vercel-build -> migrate -> next build); this test guards the SQL
 * shape. Mirrors migration-168-structure.ts.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "169_ogiam_decisions.sql"), "utf-8");
const DOWN_PATH = join(DIR, "169_ogiam_decisions.down.sql");

describe("migration 169 up", () => {
  it("creates ogiam_decisions idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS ogiam_decisions/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });

  it("carries the hash-chain columns and the would_block metric", () => {
    expect(UP).toMatch(/prev_hash\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/entry_hash\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/would_block\s+BOOLEAN\s+NOT NULL/);
    expect(UP).toMatch(/params_hash\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/risk_tier\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/intended_outcome\s+TEXT\s+NOT NULL/);
  });

  it("guards the per-workspace chain with a UNIQUE (workspace_id, seq)", () => {
    expect(UP).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*seq\s*\)/);
  });

  it("reserves a nullable signature column for the enforce phase", () => {
    expect(UP).toMatch(/signature\s+TEXT/);
  });

  it("creates the explorer + would-block indexes", () => {
    expect(UP).toMatch(/CREATE INDEX IF NOT EXISTS idx_ogiam_decisions_workspace_created/);
    expect(UP).toMatch(/CREATE INDEX IF NOT EXISTS idx_ogiam_decisions_workspace_would_block/);
  });
});

describe("migration 169 down", () => {
  it("exists and drops the table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(readFileSync(DOWN_PATH, "utf-8")).toMatch(/DROP TABLE IF EXISTS ogiam_decisions/);
  });
});
