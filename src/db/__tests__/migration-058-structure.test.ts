/**
 * Structural invariant test for migration 058_rename_clients.sql.
 *
 * Parses the up + down SQL files and asserts the safety structure
 * required by the Tier 4 rename playbook:
 *
 *   - Both old and new table names appear in the up migration
 *   - Up migration contains a DO $$ ... $$ defensive block
 *   - Row-count snapshot + assertion is present
 *   - A backward-compat VIEW is created for the old name
 *   - Compat-view updatability assertion is present
 *   - Secondary index rename is present
 *   - All 6 defensive cases (A through F) are enumerated
 *   - Paired .down.sql exists with the reverse operations
 *
 * If any of these invariants regress, a future edit to the migration
 * will fail this test BEFORE the migration ships.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "058_rename_clients.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "058_rename_clients.down.sql");

describe("migration 058_rename_clients structural invariants", () => {
  describe("up migration", () => {
    const up = readFileSync(UP_PATH, "utf-8");

    it("exists and is non-empty", () => {
      expect(up.length).toBeGreaterThan(200);
    });

    it("mentions both old and new table names", () => {
      expect(up).toMatch(/apex_clients/);
      expect(up).toMatch(/instinct_clients/);
    });

    it("contains a defensive DO $$ ... $$ block", () => {
      expect(up).toMatch(/DO\s*\$\$[\s\S]+?\$\$;/);
    });

    it("snapshots pre-rename row count", () => {
      expect(up).toMatch(/pre_rename_count/);
      expect(up).toMatch(/SELECT COUNT\(\*\) FROM apex_clients/);
    });

    it("asserts post-rename row count matches", () => {
      expect(up).toMatch(/post_rename_count/);
      expect(up).toMatch(/Row-count mismatch/i);
    });

    it("enumerates all six defensive cases A-F", () => {
      for (const letter of ["A", "B", "C", "D", "E", "F"]) {
        expect(up).toMatch(new RegExp(`Case ${letter}\\b`));
      }
    });

    it("drops the migration-014 alias view before renaming (Case B)", () => {
      expect(up).toMatch(/DROP VIEW instinct_clients/);
    });

    it("renames the table apex_clients → instinct_clients", () => {
      expect(up).toMatch(/ALTER TABLE apex_clients RENAME TO instinct_clients/);
    });

    it("creates a backward-compat VIEW apex_clients → instinct_clients", () => {
      expect(up).toMatch(
        /CREATE OR REPLACE VIEW apex_clients AS SELECT \* FROM instinct_clients/,
      );
    });

    it("renames the GIN trigram index on name", () => {
      expect(up).toMatch(
        /ALTER INDEX IF EXISTS idx_apex_clients_name RENAME TO idx_instinct_clients_name/,
      );
    });

    it("asserts the compat view is updatable + insertable", () => {
      expect(up).toMatch(/is_updatable/);
      expect(up).toMatch(/is_insertable_into/);
      expect(up).toMatch(/NOT updatable/);
      expect(up).toMatch(/NOT insertable/);
    });

    it("is wrapped in a BEGIN/COMMIT transaction", () => {
      expect(up).toMatch(/^BEGIN;/m);
      expect(up).toMatch(/COMMIT;\s*$/);
    });
  });

  describe("down migration", () => {
    it("exists", () => {
      expect(existsSync(DOWN_PATH)).toBe(true);
    });

    const down = existsSync(DOWN_PATH) ? readFileSync(DOWN_PATH, "utf-8") : "";

    it("drops the compat view so the old table name is free", () => {
      expect(down).toMatch(/DROP VIEW IF EXISTS apex_clients/);
    });

    it("reverses the index rename", () => {
      expect(down).toMatch(
        /ALTER INDEX IF EXISTS idx_instinct_clients_name RENAME TO idx_apex_clients_name/,
      );
    });

    it("reverses the table rename", () => {
      expect(down).toMatch(
        /ALTER TABLE IF EXISTS instinct_clients RENAME TO apex_clients/,
      );
    });

    it("restores the migration-014 alias view", () => {
      expect(down).toMatch(
        /CREATE OR REPLACE VIEW instinct_clients AS[\s\S]*?SELECT \* FROM apex_clients/,
      );
    });

    it("is wrapped in a BEGIN/COMMIT transaction", () => {
      expect(down).toMatch(/^BEGIN;/m);
      expect(down).toMatch(/COMMIT;\s*$/);
    });
  });
});
