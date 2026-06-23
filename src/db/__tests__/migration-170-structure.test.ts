/**
 * Structural invariant test for 170_ogiam_checkpoints.sql.
 *
 * Locks the notarization additions:
 *   - ogiam_decisions gains hash_payload via ADD COLUMN IF NOT EXISTS (additive;
 *     no DROP COLUMN / DROP TABLE / DELETE in the up file).
 *   - ogiam_checkpoints is created idempotently with the signed-chain-head shape
 *     (through_seq, head_hash, payload, algorithm, key_id, nullable signature)
 *     and a UNIQUE (workspace_id, through_seq).
 *   - The paired down drops the table and the column.
 *
 * Full DB execution is exercised by the deploy-time migrate run. Mirrors the
 * other migration-NNN-structure tests, but allows the additive ALTER ... ADD
 * COLUMN that this migration legitimately uses.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "170_ogiam_checkpoints.sql"), "utf-8");
const DOWN_PATH = join(DIR, "170_ogiam_checkpoints.down.sql");

describe("migration 170 up", () => {
  it("adds hash_payload additively (ADD COLUMN IF NOT EXISTS, no destructive ops)", () => {
    expect(UP).toMatch(/ALTER TABLE ogiam_decisions\s+ADD COLUMN IF NOT EXISTS hash_payload TEXT/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DROP COLUMN/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
  });

  it("creates ogiam_checkpoints idempotently with the signed-head columns", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS ogiam_checkpoints/);
    expect(UP).toMatch(/through_seq\s+BIGINT\s+NOT NULL/);
    expect(UP).toMatch(/head_hash\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/payload\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/algorithm\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/key_id\s+TEXT\s+NOT NULL/);
    // signature is nullable (no NOT NULL): notarization can be unconfigured.
    expect(UP).toMatch(/signature\s+TEXT\s*,/);
  });

  it("guards one checkpoint per (workspace, through_seq)", () => {
    expect(UP).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*through_seq\s*\)/);
  });
});

describe("migration 170 down", () => {
  it("drops the table and the added column", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS ogiam_checkpoints/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS hash_payload/);
  });
});
