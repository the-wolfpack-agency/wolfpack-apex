/**
 * Structural invariant test for 172_agent_scans.sql: additive/idempotent,
 * stores the JSONB model plus denormalized counts, indexed by agent, and the
 * paired down drops the table.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "172_agent_scans.sql"), "utf-8");
const DOWN_PATH = join(DIR, "172_agent_scans.down.sql");

describe("migration 172 up", () => {
  it("creates instinct_agent_scans idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agent_scans/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });
  it("stores the model JSONB and denormalized counts", () => {
    expect(UP).toMatch(/model\s+JSONB\s+NOT NULL/);
    expect(UP).toMatch(/tool_count\s+INTEGER\s+NOT NULL/);
    expect(UP).toMatch(/allowed_tool_count\s+INTEGER\s+NOT NULL/);
    expect(UP).toMatch(/capability_count\s+INTEGER\s+NOT NULL/);
  });
  it("indexes by agent", () => {
    expect(UP).toMatch(/CREATE INDEX IF NOT EXISTS idx_instinct_agent_scans_agent/);
  });
});

describe("migration 172 down", () => {
  it("drops the table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(readFileSync(DOWN_PATH, "utf-8")).toMatch(/DROP TABLE IF EXISTS instinct_agent_scans/);
  });
});
