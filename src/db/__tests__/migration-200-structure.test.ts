/** Structural invariant test for 200_sweep_runs_ux_kind.sql.
 *
 * 200 widens instinct_sweep_runs.kind CHECK from ('engagement','pentest') to
 * ('engagement','pentest','ux') so a continuous UX sweep run can be recorded in
 * the SAME health ledger (migration 198). It must:
 *   - drop + re-add the NAMED constraint idempotently (re-runnable),
 *   - add no columns / drop nothing,
 *   - and the paired .down.sql restores the 2-value set.
 * Mirrors how 182 / 199 widened the connector auth_type CHECK.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "200_sweep_runs_ux_kind.sql"), "utf-8");
const DOWN_PATH = join(DIR, "200_sweep_runs_ux_kind.down.sql");

describe("migration 200 up", () => {
  it("widens the kind CHECK to include 'ux' via a drop + re-add of the named constraint", () => {
    expect(UP).toMatch(
      /DROP CONSTRAINT IF EXISTS instinct_sweep_runs_kind_chk/,
    );
    expect(UP).toMatch(
      /ADD CONSTRAINT instinct_sweep_runs_kind_chk\s+CHECK \(kind IN \('engagement', 'pentest', 'ux'\)\)/,
    );
  });

  it("is additive: no new columns, no table/column drops, no data deletion", () => {
    expect(UP).not.toMatch(/ADD COLUMN/i);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DROP COLUMN/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
  });

  it("is transactional", () => {
    expect(UP).toMatch(/BEGIN;/);
    expect(UP).toMatch(/COMMIT;/);
  });
});

describe("migration 200 down", () => {
  it("restores the 2-value kind CHECK ('engagement','pentest')", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS instinct_sweep_runs_kind_chk/);
    expect(down).toMatch(
      /ADD CONSTRAINT instinct_sweep_runs_kind_chk\s+CHECK \(kind IN \('engagement', 'pentest'\)\)/,
    );
    // The re-added CHECK must not include 'ux' (the comment may reference it).
    expect(down).not.toMatch(/CHECK \(kind IN \([^)]*'ux'[^)]*\)\)/);
  });
});
