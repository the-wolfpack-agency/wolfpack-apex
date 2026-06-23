/**
 * Structural invariant test for 167_dedup_user_feedback.sql.
 *
 * Locks the one-time physical de-duplication of instinct_user_feedback:
 *   - Wrapped in BEGIN/COMMIT, data cleanup only (no schema change).
 *   - Partitions by (workspace_id, user_id, btrim(lower(message))) so case- and
 *     whitespace-only variants of a note collapse into one group.
 *   - Keep rule: prefer a resolved row, otherwise the earliest created_at; the
 *     rest (rank > 1) are deleted.
 *   - Paired .down.sql is a no-op (deleted duplicates are unrecoverable).
 *
 * Full DB execution is exercised by the deploy-time migrate run
 * (npm run vercel-build -> migrate -> next build); this test guards the SQL
 * shape so a future edit cannot silently weaken the keep/delete rule. There is
 * no embedded-Postgres harness in this repo, so structural assertions over the
 * SQL text are the layer that runs in CI (matching migration-166-structure.ts).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "167_dedup_user_feedback.sql"), "utf-8");
const DOWN_PATH = join(DIR, "167_dedup_user_feedback.down.sql");

describe("migration 167 up", () => {
  it("is transactional and touches only instinct_user_feedback (data cleanup, no schema change)", () => {
    expect(UP).toMatch(/BEGIN;/);
    expect(UP).toMatch(/COMMIT;/);
    expect(UP).toMatch(/DELETE FROM instinct_user_feedback/);
    // No schema mutation; this is a data-only cleanup.
    expect(UP).not.toMatch(/ALTER TABLE/i);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/CREATE TABLE/i);
  });

  it("groups case- and whitespace-insensitively per workspace + user", () => {
    expect(UP).toMatch(
      /PARTITION BY workspace_id, user_id, btrim\(lower\(message\)\)/,
    );
  });

  it("keeps a resolved row first, then the earliest, deleting the rest", () => {
    expect(UP).toMatch(/ROW_NUMBER\(\) OVER/);
    expect(UP).toMatch(
      /ORDER BY \(resolved_at IS NOT NULL\) DESC, created_at ASC/,
    );
    // Only ranks beyond the first survivor are removed.
    expect(UP).toMatch(/WHERE rn > 1/);
  });

  it("reports the remaining duplicate-group count (operator visibility)", () => {
    expect(UP).toMatch(/RAISE NOTICE/);
  });
});

describe("migration 167 down", () => {
  const down = existsSync(DOWN_PATH) ? readFileSync(DOWN_PATH, "utf-8") : "";

  it("exists and is an explicit no-op (deletes are unrecoverable)", () => {
    expect(down).not.toBe("");
    expect(down).toMatch(/no-op/i);
    expect(down).toMatch(/SELECT 1;/);
    // A rollback must NOT try to re-insert or otherwise mutate the table.
    expect(down).not.toMatch(/INSERT INTO/i);
    expect(down).not.toMatch(/DELETE FROM/i);
  });
});
