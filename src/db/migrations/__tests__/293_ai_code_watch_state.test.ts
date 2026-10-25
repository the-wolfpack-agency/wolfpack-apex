/**
 * Shape guard for 293_ai_code_watch_state.sql (offline; no DB). The watcher's
 * memory: one row per (workspace, repo, PR, head SHA) and one per PR per day.
 * The real-Postgres proof is src/db/__tests__/ai-code-watch-state.db.test.ts.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "293_ai_code_watch_state.sql");
const DOWN = path.resolve(__dirname, "..", "293_ai_code_watch_state.down.sql");

describe("293_ai_code_watch_state.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");
  const executable = sql.replace(/--[^\n]*/g, "");

  test("creates both tables idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_ai_code_watch_state/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_ai_code_watch_daily/i);
  });
  test("state is keyed per head SHA, daily per UTC day", () => {
    expect(executable).toMatch(/PRIMARY KEY \(workspace_id, repo, pr_number, head_sha\)/i);
    expect(executable).toMatch(/PRIMARY KEY \(workspace_id, repo, pr_number, day\)/i);
  });
  test("workspace-scoped", () => {
    expect(executable.match(/workspace_id\s+TEXT\s+NOT NULL/gi)).toHaveLength(2);
  });
  test("RLS enabled on both, policies guarded", () => {
    expect(executable.match(/ENABLE ROW LEVEL SECURITY/gi)).toHaveLength(2);
    expect(executable.match(/DROP POLICY IF EXISTS/gi)).toHaveLength(2);
  });
  test("has a paired down migration that drops both tables", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_ai_code_watch_state/i);
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_ai_code_watch_daily/i);
  });
});
