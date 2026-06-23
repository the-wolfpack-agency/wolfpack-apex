/** Structural invariant test for 173_agent_tasks.sql. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "173_agent_tasks.sql"), "utf-8");
const DOWN_PATH = join(DIR, "173_agent_tasks.down.sql");

describe("migration 173 up", () => {
  it("creates instinct_agent_tasks idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agent_tasks/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });
  it("carries the goal, status, JSONB steps, and assignment", () => {
    expect(UP).toMatch(/goal\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/status\s+TEXT\s+NOT NULL\s+DEFAULT 'queued'/);
    expect(UP).toMatch(/steps\s+JSONB\s+NOT NULL/);
    expect(UP).toMatch(/assigned_by\s+TEXT\s+NOT NULL/);
  });
  it("indexes by agent and by workspace+status", () => {
    expect(UP).toMatch(/idx_instinct_agent_tasks_agent/);
    expect(UP).toMatch(/idx_instinct_agent_tasks_workspace_status/);
  });
});

describe("migration 173 down", () => {
  it("drops the table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(readFileSync(DOWN_PATH, "utf-8")).toMatch(/DROP TABLE IF EXISTS instinct_agent_tasks/);
  });
});
