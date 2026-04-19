/**
 * Structural invariants for migration 059_rename_discussions.
 *
 * We don't spin up real Postgres for this test — we parse the SQL file
 * directly (same pattern as brief-edit-migration.test.ts and
 * user-id-columns-schema.test.ts) and enforce the rules that would
 * otherwise only fail in production:
 *
 *   1. Both old and new table names appear (rename is on-ramp).
 *   2. Defensive DO block is present.
 *   3. Backward-compat view is created (so missed code refs still work).
 *   4. Row-count invariant assertion is present (no silent data loss).
 *   5. A paired .down.sql file exists and reverses the operation.
 *   6. The v_discussion_velocity learning view is handled (drop+rebuild
 *      pattern) — skipping this causes 0A000 feature_not_supported.
 *   7. The comment header documents the batch/stream ownership.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "059_rename_discussions.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "059_rename_discussions.down.sql");

const upSql = readFileSync(UP_PATH, "utf8");

describe("migration 059 — apex_discussions → instinct_discussions", () => {
  it("references both the old and new table names", () => {
    expect(upSql).toMatch(/\bapex_discussions\b/);
    expect(upSql).toMatch(/\binstinct_discussions\b/);
  });

  it("has a header comment block that documents the batch/stream", () => {
    // First 80 lines should be a comment block that names the batch.
    const header = upSql.split("\n").slice(0, 80).join("\n");
    expect(header).toMatch(/Tier 4/);
    expect(header).toMatch(/batch 5/);
    expect(header).toMatch(/apex_discussions.*instinct_discussions/);
  });

  it("uses a DO block for defensive rename logic", () => {
    expect(upSql).toMatch(/DO\s+\$\$/);
    // The DO block must declare state-detection variables.
    expect(upSql).toMatch(/apex_exists_as_table\s+BOOLEAN/);
    expect(upSql).toMatch(/instinct_kind\s+CHAR/);
  });

  it("handles all six defensive cases (A-F)", () => {
    // Check for case labels in the comment markers.
    for (const caseLetter of ["A", "B", "C", "D", "E", "F"]) {
      const re = new RegExp(`Case\\s+${caseLetter}\\b`);
      expect(upSql).toMatch(re);
    }
  });

  it("performs ALTER TABLE RENAME on the apex table", () => {
    expect(upSql).toMatch(
      /ALTER\s+TABLE\s+apex_discussions\s+RENAME\s+TO\s+instinct_discussions/i,
    );
  });

  it("creates a backward-compat view apex_discussions → instinct_discussions", () => {
    expect(upSql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+VIEW\s+apex_discussions\s+AS\s+SELECT\s+\*\s+FROM\s+instinct_discussions/i,
    );
  });

  it("asserts the compat view is updatable AND insertable (no silent write-discard)", () => {
    expect(upSql).toMatch(/is_updatable/);
    expect(upSql).toMatch(/is_insertable_into/);
    expect(upSql).toMatch(/NOT\s+updatable/i);
    expect(upSql).toMatch(/NOT\s+insertable/i);
  });

  it("includes a pre/post rename row-count invariant assertion", () => {
    expect(upSql).toMatch(/pre_rename_count/);
    expect(upSql).toMatch(/post_rename_count/);
    expect(upSql).toMatch(/Row-count mismatch/i);
  });

  it("drops and rebuilds v_discussion_velocity to avoid 0A000", () => {
    // The learning view from migration 002 depends on apex_discussions.
    // Postgres will raise 0A000 feature_not_supported if we don't drop it
    // before ALTER TABLE RENAME.
    expect(upSql).toMatch(/v_discussion_velocity/);
    expect(upSql).toMatch(/DROP\s+VIEW\s+v_discussion_velocity/i);
    expect(upSql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+v_discussion_velocity/i);
  });

  it("renames all three secondary indexes created by migration 001", () => {
    expect(upSql).toMatch(
      /ALTER\s+INDEX\s+IF\s+EXISTS\s+idx_apex_discussions_category\s+RENAME\s+TO\s+idx_instinct_discussions_category/i,
    );
    expect(upSql).toMatch(
      /ALTER\s+INDEX\s+IF\s+EXISTS\s+idx_apex_discussions_status\s+RENAME\s+TO\s+idx_instinct_discussions_status/i,
    );
    expect(upSql).toMatch(
      /ALTER\s+INDEX\s+IF\s+EXISTS\s+idx_apex_discussions_created_by\s+RENAME\s+TO\s+idx_instinct_discussions_created_by/i,
    );
  });

  it("wraps the rename in a single transaction (BEGIN/COMMIT)", () => {
    expect(upSql).toMatch(/\bBEGIN\b/);
    expect(upSql).toMatch(/\bCOMMIT\b/);
  });

  it("has a paired .down.sql file", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
  });

  describe(".down.sql", () => {
    const downSql = readFileSync(DOWN_PATH, "utf8");

    it("renames the table back instinct_discussions → apex_discussions", () => {
      expect(downSql).toMatch(
        /ALTER\s+TABLE\s+IF\s+EXISTS\s+instinct_discussions\s+RENAME\s+TO\s+apex_discussions/i,
      );
    });

    it("drops the backward-compat view first (IF EXISTS)", () => {
      expect(downSql).toMatch(/DROP\s+VIEW\s+IF\s+EXISTS\s+apex_discussions/i);
    });

    it("restores the migration-014 alias view", () => {
      expect(downSql).toMatch(
        /CREATE\s+OR\s+REPLACE\s+VIEW\s+instinct_discussions\s+AS\s+SELECT\s+\*\s+FROM\s+apex_discussions/i,
      );
    });

    it("restores v_discussion_velocity pointed at the apex tables", () => {
      expect(downSql).toMatch(/v_discussion_velocity/);
      expect(downSql).toMatch(/FROM\s+apex_discussions/i);
    });

    it("reverses all three index renames", () => {
      expect(downSql).toMatch(/idx_apex_discussions_category/);
      expect(downSql).toMatch(/idx_apex_discussions_status/);
      expect(downSql).toMatch(/idx_apex_discussions_created_by/);
    });

    it("uses IF EXISTS guards throughout (safe to re-run)", () => {
      // Every ALTER INDEX / ALTER TABLE must be guarded.
      const alters = downSql.match(/ALTER\s+(TABLE|INDEX)[^;]*/gi) || [];
      expect(alters.length).toBeGreaterThan(0);
      for (const stmt of alters) {
        expect(stmt).toMatch(/IF\s+EXISTS/i);
      }
    });
  });
});
