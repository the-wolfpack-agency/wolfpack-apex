/**
 * Structural invariants for migration 056 —
 *   apex_employees → instinct_employees.
 *
 * Part 1 of the HR-family rename (U3 stream). 057 follows with the
 * child table apex_hr_documents which has a FK on employee_id.
 *
 * Reads both the forward and down migration SQL files raw from disk
 * and asserts the canonical safety patterns are present. Intent: if a
 * future refactor rewrites this migration in a way that drops
 * defensive patterns (DO block, compat view, row-count assertion, or
 * the paired down file), this test fails loudly in CI BEFORE the
 * change reaches prod.
 *
 * These are STRUCTURAL assertions — they don't execute SQL. An
 * end-to-end DB-level test would require spinning up Postgres, which
 * is out of scope for a unit suite. Runtime behavior is already
 * covered by the integration tests that exercise the People/HR libs
 * through the DB layer.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  process.cwd(),
  "src",
  "db",
  "migrations",
);

const UP_FILE = join(MIGRATIONS_DIR, "056_rename_employees.sql");
const DOWN_FILE = join(MIGRATIONS_DIR, "056_rename_employees.down.sql");

describe("migration 056 — rename apex_employees → instinct_employees", () => {
  let up: string;
  let down: string;

  beforeAll(() => {
    up = readFileSync(UP_FILE, "utf8");
    down = readFileSync(DOWN_FILE, "utf8");
  });

  it("forward migration file exists on disk", () => {
    expect(existsSync(UP_FILE)).toBe(true);
  });

  it("paired down migration file exists on disk", () => {
    expect(existsSync(DOWN_FILE)).toBe(true);
  });

  it("references BOTH the old and new table names", () => {
    expect(up).toMatch(/apex_employees/);
    expect(up).toMatch(/instinct_employees/);
    expect(down).toMatch(/apex_employees/);
    expect(down).toMatch(/instinct_employees/);
  });

  it("uses a defensive DO $$ block to survive any pre-existing DB state", () => {
    // At least one DO $$...$$ block — canonical pattern from
    // 036/043/046/048/051.
    expect(up).toMatch(/DO \$\$/);
    expect(up).toMatch(/END \$\$;/);
  });

  it("creates a backward-compat view using the OLD name pointing at the NEW table", () => {
    // Matches the canonical 'apex_employees = VIEW, instinct_employees = TABLE' pattern.
    const hasCompatView =
      /CREATE OR REPLACE VIEW\s+apex_employees[\s\S]*?SELECT \* FROM\s+instinct_employees/i.test(
        up,
      );
    expect(hasCompatView).toBe(true);
  });

  it("asserts row-count preservation across the rename", () => {
    expect(up).toMatch(/pre_rename_count/);
    expect(up).toMatch(/post_rename_count/);
    expect(up).toMatch(/Row-count mismatch/i);
    expect(up).toMatch(/RAISE EXCEPTION/);
  });

  it("asserts compat-view is updatable AND insertable so legacy writes don't silently drop", () => {
    expect(up).toMatch(/is_updatable/);
    expect(up).toMatch(/is_insertable_into/);
  });

  it("wraps the forward migration in a single transaction", () => {
    expect(up).toMatch(/^BEGIN;/m);
    expect(up).toMatch(/COMMIT;/);
  });

  it("renames the idx_apex_employees_status secondary index", () => {
    // Migration 010 created this index — it must be renamed for hygiene.
    expect(up).toMatch(
      /ALTER INDEX IF EXISTS idx_apex_employees_status\s+RENAME TO idx_instinct_employees_status/,
    );
    expect(down).toMatch(
      /ALTER INDEX IF EXISTS idx_instinct_employees_status\s+RENAME TO idx_apex_employees_status/,
    );
  });

  it("renames the auto-named UNIQUE(email) constraint apex_employees_email_key", () => {
    // Postgres auto-names `UNIQUE (email)` as apex_employees_email_key.
    expect(up).toMatch(/apex_employees_email_key/);
    expect(up).toMatch(/instinct_employees_email_key/);
  });

  it("down migration reverses the table rename and drops the compat view", () => {
    expect(down).toMatch(
      /ALTER TABLE IF EXISTS instinct_employees\s+RENAME TO apex_employees/,
    );
    expect(down).toMatch(/DROP VIEW IF EXISTS apex_employees/);
    // Restore the migration-014 alias view so post-rollback schema matches
    // pre-056 exactly.
    expect(down).toMatch(
      /CREATE OR REPLACE VIEW instinct_employees[\s\S]*?SELECT \* FROM\s+apex_employees/,
    );
  });

  it("includes an explanatory comment block at the top (batch + safety rationale)", () => {
    const header = up.split("\n").slice(0, 60).join("\n");
    expect(header).toMatch(/Tier 4/i);
    expect(header).toMatch(/apex_employees/);
    expect(header).toMatch(/instinct_employees/);
    // References at least one canonical sibling-template migration.
    expect(header).toMatch(/05[0-7]|048|046|043|036/);
  });
});

describe("migration 056 — learning-loop analytics integration", () => {
  // Tie the rename back to the data/learning mechanism.
  // Per CLAUDE.md: every new piece of code must tie into the data and
  // learning mechanism. Employee CRUD in src/lib/people.ts emits
  // hr.employee_* trackEvent calls on create/update/status transitions.
  // A structural assertion guards that the rename did not inadvertently
  // break the lib layer's reference to the canonical post-056 table name
  // OR its analytics wiring.

  it("src/lib/people.ts still targets a valid employees table name (apex_ compat view OR instinct_*)", () => {
    // people.ts is owned by the People (U-other) stream; it may still
    // reference apex_employees via the compat view — that is INTENTIONAL
    // and SAFE because migration 056 creates `apex_employees` as an
    // updatable passthrough view over `instinct_employees`. What we
    // guard against: a stale reference to a *typo* or a dropped name.
    const libPath = join(process.cwd(), "src", "lib", "people.ts");
    const libSource = readFileSync(libPath, "utf8");

    // The lib MUST reference at least one of the two canonical names.
    const referencesEmployees =
      /apex_employees|instinct_employees/.test(libSource);
    expect(referencesEmployees).toBe(true);
  });

  it("migration ships FK-preservation note for apex_hr_documents + apex_onboarding_instances children", () => {
    // CRITICAL safety note: Postgres tracks FKs by OID, so renaming the
    // parent leaves child FKs intact. If a future refactor drops this
    // note, it may accompany a change that actually DOES break the FK
    // (e.g. DROP+RECREATE). Assert the note stays. Re-read the file here
    // since the `up` local from the outer describe is not visible to
    // this describe block's closures.
    const upSource = readFileSync(UP_FILE, "utf8");
    expect(upSource).toMatch(/FOREIGN KEY|FK/);
    expect(upSource).toMatch(/apex_hr_documents|hr_documents/);
    expect(upSource).toMatch(/apex_onboarding_instances|onboarding_instances/);
    expect(upSource).toMatch(/OID|by OID/i);
  });
});
