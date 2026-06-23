/** Structural invariant test for 175_agent_drift.sql. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "175_agent_drift.sql"), "utf-8");
const DOWN_PATH = join(DIR, "175_agent_drift.down.sql");
describe("migration 175 up", () => {
  it("creates the baselines + drift events tables idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agent_baselines/);
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agent_drift_events/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
  });
  it("stores the baseline metrics and the drift verdict + action", () => {
    expect(UP).toMatch(/agent_id\s+TEXT\s+PRIMARY KEY/);
    expect(UP).toMatch(/metrics\s+JSONB\s+NOT NULL/);
    expect(UP).toMatch(/drift_score\s+DOUBLE PRECISION\s+NOT NULL/);
    expect(UP).toMatch(/verdict\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/action\s+TEXT\s+NOT NULL/);
  });
});
describe("migration 175 down", () => {
  it("drops both tables", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_agent_drift_events/);
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_agent_baselines/);
  });
});
