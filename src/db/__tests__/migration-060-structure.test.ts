/**
 * Structural invariants for migration 060_rename_discussion_replies.
 *
 * Sibling of migration-059-structure.test.ts — both run as part of the
 * Tier 4 batch 5 U5 discussions family rename. Migration 060 has an
 * extra complication: it FKs migration 059's parent table, and it
 * participates in the v_discussion_velocity learning view.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "060_rename_discussion_replies.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "060_rename_discussion_replies.down.sql");

const upSql = readFileSync(UP_PATH, "utf8");

describe("migration 060 — apex_discussion_replies → instinct_discussion_replies", () => {
  it("references both the old and new table names", () => {
    expect(upSql).toMatch(/\bapex_discussion_replies\b/);
    expect(upSql).toMatch(/\binstinct_discussion_replies\b/);
  });

  it("has a header comment block that documents the batch/stream", () => {
    const header = upSql.split("\n").slice(0, 60).join("\n");
    expect(header).toMatch(/Tier 4/);
    expect(header).toMatch(/batch 5/);
    expect(header).toMatch(/apex_discussion_replies.*instinct_discussion_replies/);
  });

  it("uses a DO block for defensive rename logic", () => {
    expect(upSql).toMatch(/DO\s+\$\$/);
    expect(upSql).toMatch(/apex_exists_as_table\s+BOOLEAN/);
    expect(upSql).toMatch(/instinct_kind\s+CHAR/);
  });

  it("handles all six defensive cases (A-F)", () => {
    for (const caseLetter of ["A", "B", "C", "D", "E", "F"]) {
      const re = new RegExp(`Case\\s+${caseLetter}\\b`);
      expect(upSql).toMatch(re);
    }
  });

  it("performs ALTER TABLE RENAME on the apex replies table", () => {
    expect(upSql).toMatch(
      /ALTER\s+TABLE\s+apex_discussion_replies\s+RENAME\s+TO\s+instinct_discussion_replies/i,
    );
  });

  it("creates a backward-compat view apex_discussion_replies → instinct_discussion_replies", () => {
    expect(upSql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+VIEW\s+apex_discussion_replies\s+AS\s+SELECT\s+\*\s+FROM\s+instinct_discussion_replies/i,
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
    // v_discussion_velocity selects FROM apex_discussion_replies (post-059),
    // so the same drop-then-rebuild dance is required here.
    expect(upSql).toMatch(/v_discussion_velocity/);
    expect(upSql).toMatch(/DROP\s+VIEW\s+v_discussion_velocity/i);
    expect(upSql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+v_discussion_velocity/i);
    // The rebuilt view should reference the renamed replies table in at
    // least one branch (the happy path where 059 ran first).
    expect(upSql).toMatch(
      /FROM\s+instinct_discussion_replies\s+r/i,
    );
  });

  it("renames both secondary indexes created by migration 001", () => {
    expect(upSql).toMatch(
      /ALTER\s+INDEX\s+IF\s+EXISTS\s+idx_apex_replies_discussion\s+RENAME\s+TO\s+idx_instinct_discussion_replies_discussion/i,
    );
    expect(upSql).toMatch(
      /ALTER\s+INDEX\s+IF\s+EXISTS\s+idx_apex_replies_author\s+RENAME\s+TO\s+idx_instinct_discussion_replies_author/i,
    );
  });

  it("documents that the FK to the parent table is preserved automatically by ALTER TABLE RENAME", () => {
    // This is a critical invariant — the FK from discussion_id to the
    // parent survives ALTER TABLE RENAME on either side. The migration
    // header must document this so future readers don't try to manually
    // DROP/ADD CONSTRAINT and break cascade deletes.
    expect(upSql).toMatch(/FK[\s\S]*?preserved/i);
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

    it("renames the table back instinct_discussion_replies → apex_discussion_replies", () => {
      expect(downSql).toMatch(
        /ALTER\s+TABLE\s+IF\s+EXISTS\s+instinct_discussion_replies\s+RENAME\s+TO\s+apex_discussion_replies/i,
      );
    });

    it("drops the backward-compat view first (IF EXISTS)", () => {
      expect(downSql).toMatch(/DROP\s+VIEW\s+IF\s+EXISTS\s+apex_discussion_replies/i);
    });

    it("restores the migration-014 alias view", () => {
      expect(downSql).toMatch(
        /CREATE\s+OR\s+REPLACE\s+VIEW\s+instinct_discussion_replies\s+AS\s+SELECT\s+\*\s+FROM\s+apex_discussion_replies/i,
      );
    });

    it("restores v_discussion_velocity pointed at the apex tables", () => {
      expect(downSql).toMatch(/v_discussion_velocity/);
      expect(downSql).toMatch(/FROM\s+apex_discussions/i);
      expect(downSql).toMatch(/FROM\s+apex_discussion_replies/i);
    });

    it("reverses both index renames", () => {
      expect(downSql).toMatch(/idx_apex_replies_discussion/);
      expect(downSql).toMatch(/idx_apex_replies_author/);
    });

    it("uses IF EXISTS guards throughout (safe to re-run)", () => {
      const alters = downSql.match(/ALTER\s+(TABLE|INDEX)[^;]*/gi) || [];
      expect(alters.length).toBeGreaterThan(0);
      for (const stmt of alters) {
        expect(stmt).toMatch(/IF\s+EXISTS/i);
      }
    });
  });
});
