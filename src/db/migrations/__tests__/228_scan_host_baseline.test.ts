/**
 * Shape guard for 228_scan_host_baseline.sql (offline; no DB).
 *
 * The assertion that matters is that the upsert cannot overwrite first_seen_at.
 * "When did this host appear" is the question an incident review asks, and it is
 * unanswerable once the value has been stamped over. store.test.ts pins the same
 * rule against the query the app sends; this pins the column that makes it
 * possible to ask at all.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "228_scan_host_baseline.sql");
const DOWN = path.resolve(__dirname, "..", "228_scan_host_baseline.down.sql");

describe("228_scan_host_baseline.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");
  const executable = sql.replace(/--[^\n]*/g, "");

  test("creates both tables idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_scan_host_baseline/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_scan_anomaly_runs/i);
  });

  test("the baseline is keyed by workspace AND target, so one client cannot vouch for another", () => {
    expect(executable).toMatch(/PRIMARY KEY \(workspace_id, target_id, host\)/i);
  });

  test("both tables are workspace-scoped", () => {
    // The repo-wide tenant-isolation scan requires the predicate to be visible
    // in every query; that is only possible if the column exists.
    const tables = executable.split(/CREATE TABLE/i).slice(1);
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
  });

  test("first_seen_at and last_seen_at are separate columns", () => {
    // A single timestamp cannot answer both "when did it appear" and "is it
    // still here", and the first is the one an incident review needs.
    expect(executable).toMatch(/first_seen_at\s+TIMESTAMPTZ\s+NOT NULL/i);
    expect(executable).toMatch(/last_seen_at\s+TIMESTAMPTZ\s+NOT NULL/i);
  });

  test("records whether a run was trusted enough to learn from", () => {
    // "We chose not to trust this run" is a fact worth keeping: it explains a
    // gap in the history to whoever finds one later.
    expect(executable).toMatch(/baseline_updated\s+BOOLEAN\s+NOT NULL DEFAULT FALSE/i);
  });

  test("stores the whole report, so a finding can be re-read as it was shown", () => {
    expect(executable).toMatch(/report\s+JSONB\s+NOT NULL/i);
    expect(executable).toMatch(/caveats\s+JSONB\s+NOT NULL/i);
  });

  test("indexes both target reads", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_scan_host_baseline_target/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_scan_anomaly_runs_target/i);
  });

  test("has a paired reversible down migration that drops indexes before tables", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_scan_host_baseline/i);
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_scan_anomaly_runs/i);
    expect(down.indexOf("DROP INDEX")).toBeLessThan(down.indexOf("DROP TABLE"));
  });
});
