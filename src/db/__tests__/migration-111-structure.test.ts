/**
 * Structural invariant test for migration 111 — instinct_email_signatures.
 *
 * Reads the migration .sql and .down.sql files raw from disk and asserts:
 *   - Forward + down files both exist
 *   - Forward CREATEs the table guarded by IF NOT EXISTS
 *   - Forward has a BEGIN/COMMIT transaction wrap
 *   - Forward has the partial unique index that enforces "at most one
 *     default per user" — the DB-level guarantee that lib/email-signatures
 *     relies on
 *   - Forward has a final ASSERT that validates the column shape
 *   - Down reverses with DROP IF EXISTS in reverse order
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const FORWARD = path.join(MIGRATIONS_DIR, "111_email_signatures.sql");
const DOWN = path.join(MIGRATIONS_DIR, "111_email_signatures.down.sql");

describe("migration 111 — structural invariants", () => {
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

  it("wraps the forward in a BEGIN/COMMIT transaction", () => {
    expect(forwardSql).toMatch(/^BEGIN;/m);
    expect(forwardSql).toMatch(/^COMMIT;/m);
  });

  it("creates instinct_email_signatures with IF NOT EXISTS", () => {
    expect(forwardSql).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_email_signatures/,
    );
  });

  it("declares the expected columns", () => {
    for (const col of [
      "id UUID PRIMARY KEY",
      "user_id TEXT NOT NULL",
      "label TEXT NOT NULL",
      "body TEXT NOT NULL",
      "is_default BOOLEAN",
      "created_at TIMESTAMPTZ",
      "updated_at TIMESTAMPTZ",
    ]) {
      expect(forwardSql).toMatch(new RegExp(col));
    }
  });

  it("creates the partial unique index enforcing one default per user", () => {
    expect(forwardSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS\s+uq_email_signatures_one_default_per_user/);
    expect(forwardSql).toMatch(/WHERE is_default = TRUE/);
  });

  it("creates the user_id, is_default DESC, created_at DESC index", () => {
    expect(forwardSql).toMatch(
      /idx_email_signatures_user_default[\s\S]+\(user_id, is_default DESC, created_at DESC\)/,
    );
  });

  it("ends with an ASSERT that validates the column shape", () => {
    expect(forwardSql).toMatch(/ASSERT \(/);
    expect(forwardSql).toMatch(/instinct_email_signatures missing expected columns/);
  });

  it("down reverses with DROP IF EXISTS in reverse order (indexes first, then table)", () => {
    expect(downSql).toMatch(
      /DROP INDEX IF EXISTS uq_email_signatures_one_default_per_user/,
    );
    expect(downSql).toMatch(
      /DROP INDEX IF EXISTS idx_email_signatures_user_default/,
    );
    expect(downSql).toMatch(/DROP TABLE IF EXISTS instinct_email_signatures/);

    /* Drops must come BEFORE the table drop (indexes first). */
    const idxDrop = downSql.indexOf(
      "DROP INDEX IF EXISTS uq_email_signatures_one_default_per_user",
    );
    const tblDrop = downSql.indexOf(
      "DROP TABLE IF EXISTS instinct_email_signatures",
    );
    expect(idxDrop).toBeLessThan(tblDrop);
  });
});
