/** Structural invariant test for 174_agent_memory.sql. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "174_agent_memory.sql"), "utf-8");
const DOWN_PATH = join(DIR, "174_agent_memory.down.sql");
describe("migration 174 up", () => {
  it("creates instinct_agent_memory idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agent_memory/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });
  it("keys procedures by goal, stores the plan + status + provenance", () => {
    expect(UP).toMatch(/goal_key\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/plan\s+JSONB\s+NOT NULL/);
    expect(UP).toMatch(/status\s+TEXT\s+NOT NULL\s+DEFAULT 'quarantined'/);
    expect(UP).toMatch(/learned_by_agent\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/hit_count\s+INTEGER\s+NOT NULL/);
  });
  it("enforces one procedure per (workspace, goal_key)", () => {
    expect(UP).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*goal_key\s*\)/);
  });
});
describe("migration 174 down", () => {
  it("drops the table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(readFileSync(DOWN_PATH, "utf-8")).toMatch(/DROP TABLE IF EXISTS instinct_agent_memory/);
  });
});
