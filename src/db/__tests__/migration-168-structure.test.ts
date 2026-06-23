/**
 * Structural invariant test for 168_feedback_screenshot.sql.
 *
 * Locks the shape of the optional one-to-one screenshot table:
 *   - CREATE TABLE IF NOT EXISTS instinct_feedback_screenshot (additive,
 *     idempotent, no destructive statements in the up migration).
 *   - feedback_id is the PK and REFERENCES instinct_user_feedback(id) with
 *     ON DELETE CASCADE, so deleting a feedback row drops its image too.
 *   - content_type / data_base64 / byte_size / created_at columns exist.
 *   - The paired .down.sql drops the table (the images are derived, not the
 *     source of truth, so a rollback losing only pictures is acceptable).
 *
 * Full DB execution is exercised by the deploy-time migrate run
 * (npm run vercel-build -> migrate -> next build); this test guards the SQL
 * shape so a future edit cannot silently weaken the FK / cascade rule.
 * Mirrors migration-167-structure.ts.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "168_feedback_screenshot.sql"), "utf-8");
const DOWN_PATH = join(DIR, "168_feedback_screenshot.down.sql");

describe("migration 168 up", () => {
  it("creates instinct_feedback_screenshot idempotently and additively", () => {
    expect(UP).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_feedback_screenshot/,
    );
    // Additive only: no destructive statements in the up file.
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });

  it("uses feedback_id as the primary key referencing instinct_user_feedback with ON DELETE CASCADE", () => {
    expect(UP).toMatch(/feedback_id\s+UUID\s+PRIMARY KEY/);
    expect(UP).toMatch(
      /REFERENCES instinct_user_feedback\s*\(\s*id\s*\)\s+ON DELETE CASCADE/,
    );
  });

  it("declares the content_type / data_base64 / byte_size / created_at columns", () => {
    expect(UP).toMatch(/content_type\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/data_base64\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/byte_size\s+INTEGER\s+NOT NULL/);
    expect(UP).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });
});

describe("migration 168 down", () => {
  const down = existsSync(DOWN_PATH) ? readFileSync(DOWN_PATH, "utf-8") : "";

  it("exists and drops the table", () => {
    expect(down).not.toBe("");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_feedback_screenshot/);
  });
});
