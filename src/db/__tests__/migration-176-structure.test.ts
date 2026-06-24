/** Structural invariant test for 176_ogiam_action_outcomes.sql. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "176_ogiam_action_outcomes.sql"), "utf-8");
const DOWN_PATH = join(DIR, "176_ogiam_action_outcomes.down.sql");

describe("migration 176 up", () => {
  it("creates the outcomes table idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS ogiam_action_outcomes/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    // Append-only: no UPDATE statement (only the data definition + indexes).
    expect(UP).not.toMatch(/^\s*UPDATE\s/im);
  });

  it("stores the result outcome columns linked to a decision", () => {
    expect(UP).toMatch(/id\s+UUID\s+PRIMARY KEY/);
    expect(UP).toMatch(/workspace_id\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/decision_seq\s+BIGINT\s+NOT NULL/);
    expect(UP).toMatch(/agent_id\s+TEXT/);
    expect(UP).toMatch(/ok\s+BOOLEAN\s+NOT NULL/);
    expect(UP).toMatch(/code\s+TEXT/);
    expect(UP).toMatch(/result_redacted\s+TEXT/);
    expect(UP).toMatch(/duration_ms\s+INTEGER/);
    expect(UP).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });

  it("guards both indexes idempotently", () => {
    expect(UP).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_ogiam_action_outcomes_decision\s+ON ogiam_action_outcomes \(workspace_id, decision_seq\)/,
    );
    expect(UP).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_ogiam_action_outcomes_agent\s+ON ogiam_action_outcomes \(agent_id, created_at DESC\)/,
    );
  });
});

describe("migration 176 down", () => {
  it("drops the outcomes table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS ogiam_action_outcomes/);
  });
});
