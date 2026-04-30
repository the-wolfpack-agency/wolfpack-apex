/**
 * Structural invariant test for migration 113 — bulletin boards + notes
 * + snapshots.
 *
 * Reads the migration .sql and .down.sql files raw from disk and asserts:
 *   - Forward + down files both exist
 *   - Forward CREATEs each table guarded by IF NOT EXISTS
 *   - Forward has a BEGIN/COMMIT transaction wrap
 *   - Forward has the partial indexes (active boards, active notes,
 *     active-note association lookup)
 *   - Forward has a final ASSERT validating all three tables' shapes
 *   - Down reverses with DROP IF EXISTS in reverse order (indexes first,
 *     then tables in reverse FK order: snapshots → notes → boards)
 *   - Forward is idempotent — every statement uses IF NOT EXISTS so a
 *     second invocation in the same session is a no-op (validated by
 *     parsing the file and confirming there are no bare CREATE TABLE
 *     or CREATE INDEX statements).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const FORWARD = path.join(MIGRATIONS_DIR, "113_bulletin_boards.sql");
const DOWN = path.join(MIGRATIONS_DIR, "113_bulletin_boards.down.sql");

describe("migration 113 — structural invariants", () => {
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

  it("creates instinct_bulletin_boards with IF NOT EXISTS", () => {
    expect(forwardSql).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_bulletin_boards/,
    );
  });

  it("creates instinct_bulletin_notes with IF NOT EXISTS", () => {
    expect(forwardSql).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_bulletin_notes/,
    );
  });

  it("creates instinct_bulletin_snapshots with IF NOT EXISTS", () => {
    expect(forwardSql).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_bulletin_snapshots/,
    );
  });

  it("notes table declares the expected columns", () => {
    for (const col of [
      "id UUID PRIMARY KEY",
      "board_id UUID NOT NULL REFERENCES instinct_bulletin_boards",
      "body TEXT NOT NULL",
      "color TEXT NOT NULL DEFAULT '#ffeb3b'",
      "x_pct NUMERIC",
      "y_pct NUMERIC",
      "width_pct NUMERIC",
      "height_pct NUMERIC",
      "rotation_deg NUMERIC",
      "association_kind TEXT",
      "association_id TEXT",
      "association_label TEXT",
      "created_by_user_id TEXT NOT NULL",
      "created_at TIMESTAMPTZ",
      "updated_at TIMESTAMPTZ",
      "deleted_at TIMESTAMPTZ",
    ]) {
      expect(forwardSql).toMatch(new RegExp(col));
    }
  });

  it("snapshots table stores PNG inline as BYTEA", () => {
    expect(forwardSql).toMatch(/png_bytes BYTEA NOT NULL/);
  });

  it("constrains association_kind to the allowed enum", () => {
    expect(forwardSql).toMatch(
      /CHECK \(association_kind IS NULL OR association_kind IN[\s\S]*'task'[\s\S]*'goal'[\s\S]*'meeting'[\s\S]*'discussion'[\s\S]*'calendar_event'/,
    );
  });

  it("creates the active-notes partial index keyed by board", () => {
    expect(forwardSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_bulletin_notes_board_active[\s\S]+WHERE deleted_at IS NULL/,
    );
  });

  it("creates the active-notes association lookup index", () => {
    expect(forwardSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_bulletin_notes_assoc[\s\S]+WHERE deleted_at IS NULL/,
    );
  });

  it("creates the snapshots-by-board index newest-first", () => {
    expect(forwardSql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_bulletin_snapshots_board[\s\S]+\(board_id, created_at DESC\)/,
    );
  });

  it("ends with an ASSERT that validates each table's column shape", () => {
    expect(forwardSql).toMatch(/ASSERT \(/);
    expect(forwardSql).toMatch(/instinct_bulletin_boards missing expected columns/);
    expect(forwardSql).toMatch(/instinct_bulletin_notes missing expected columns/);
    expect(forwardSql).toMatch(
      /instinct_bulletin_snapshots missing expected columns/,
    );
  });

  it("idempotency: every CREATE uses IF NOT EXISTS (no bare CREATE TABLE/INDEX)", () => {
    /* Strip comments so a doc-comment example doesn't trip the check. */
    const stripped = forwardSql.replace(/--[^\n]*\n/g, "\n");
    /* Match `CREATE TABLE` (or INDEX/UNIQUE INDEX) NOT followed by IF NOT EXISTS. */
    const bare = stripped.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi);
    expect(bare).toBeNull();
  });

  it("down reverses with DROP IF EXISTS in reverse order (snapshots → notes → boards)", () => {
    expect(downSql).toMatch(/DROP TABLE IF EXISTS instinct_bulletin_snapshots/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS instinct_bulletin_notes/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS instinct_bulletin_boards/);

    const snapDrop = downSql.indexOf("DROP TABLE IF EXISTS instinct_bulletin_snapshots");
    const notesDrop = downSql.indexOf("DROP TABLE IF EXISTS instinct_bulletin_notes");
    const boardsDrop = downSql.indexOf("DROP TABLE IF EXISTS instinct_bulletin_boards");
    expect(snapDrop).toBeLessThan(notesDrop);
    expect(notesDrop).toBeLessThan(boardsDrop);

    /* Indexes always drop before their owning tables. */
    const snapIdxDrop = downSql.indexOf("DROP INDEX IF EXISTS idx_bulletin_snapshots_board");
    expect(snapIdxDrop).toBeLessThan(snapDrop);
    const notesIdxDrop = downSql.indexOf("DROP INDEX IF EXISTS idx_bulletin_notes_board_active");
    expect(notesIdxDrop).toBeLessThan(notesDrop);
  });
});
