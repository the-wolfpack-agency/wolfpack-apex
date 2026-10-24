/** Structural invariant test for 294_sweep_runs_no_targets_status.sql.
 *
 * 294 widens instinct_sweep_runs.status CHECK from ('ok','partial','failed') to
 * include 'no_targets', so a sweep tick that assessed nothing is recorded
 * honestly instead of as 'ok'. It must:
 *   - drop + re-add the NAMED constraint idempotently (re-runnable),
 *   - touch no rows and add or drop no columns (safe on live data),
 *   - and the paired .down.sql relabels no_targets rows to 'ok' before restoring
 *     the 3-value set, so the down migration cannot fail on live rows.
 * Mirrors migration-200-structure.test.ts.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SweepStatus } from "@/lib/platform-scan/sweep-health";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "294_sweep_runs_no_targets_status.sql"), "utf-8");
const DOWN_PATH = join(DIR, "294_sweep_runs_no_targets_status.down.sql");

describe("migration 294 up", () => {
  it("widens the status CHECK to include 'no_targets' via drop + re-add of the named constraint", () => {
    expect(UP).toMatch(/DROP CONSTRAINT IF EXISTS instinct_sweep_runs_status_chk/);
    expect(UP).toMatch(
      /ADD CONSTRAINT instinct_sweep_runs_status_chk\s+CHECK \(status IN \('ok', 'partial', 'failed', 'no_targets'\)\)/,
    );
  });

  it("accepts every SweepStatus the code can write", () => {
    const all: SweepStatus[] = ["ok", "partial", "failed", "no_targets"];
    const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(UP);
    expect(m).not.toBeNull();
    const allowed = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(allowed.sort()).toEqual([...all].sort());
  });

  it("is safe on live data: no row writes, no column or table changes", () => {
    expect(UP).not.toMatch(/ADD COLUMN/i);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DROP COLUMN/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/^\s*UPDATE\s/im);
  });

  it("is transactional", () => {
    expect(UP).toMatch(/BEGIN;/);
    expect(UP).toMatch(/COMMIT;/);
  });
});

describe("migration 294 down", () => {
  const down = existsSync(DOWN_PATH) ? readFileSync(DOWN_PATH, "utf-8") : "";

  it("exists and restores the 3-value status CHECK", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS instinct_sweep_runs_status_chk/);
    expect(down).toMatch(
      /ADD CONSTRAINT instinct_sweep_runs_status_chk\s+CHECK \(status IN \('ok', 'partial', 'failed'\)\)/,
    );
    expect(down).not.toMatch(/CHECK \(status IN \([^)]*'no_targets'[^)]*\)\)/);
  });

  it("relabels no_targets rows BEFORE re-adding the narrower CHECK", () => {
    const update = down.indexOf("UPDATE instinct_sweep_runs SET status = 'ok' WHERE status = 'no_targets'");
    const add = down.indexOf("ADD CONSTRAINT instinct_sweep_runs_status_chk");
    expect(update).toBeGreaterThanOrEqual(0);
    expect(update).toBeLessThan(add);
  });
});
