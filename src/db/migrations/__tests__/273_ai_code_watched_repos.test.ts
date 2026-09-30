/**
 * Shape guard for 273_ai_code_watched_repos.sql (offline; no DB). The watcher's
 * enrolled repos are per-workspace CONFIG, so a client enrolls once and one
 * deployment serves everyone - no per-project env vars.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "273_ai_code_watched_repos.sql");
const DOWN = path.resolve(__dirname, "..", "273_ai_code_watched_repos.down.sql");

describe("273_ai_code_watched_repos.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");
  const executable = sql.replace(/--[^\n]*/g, "");

  test("creates the table idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_ai_code_watched_repos/i);
  });
  test("keyed by (workspace_id, repo): one workspace cannot collide with another", () => {
    expect(executable).toMatch(/PRIMARY KEY \(workspace_id, repo\)/i);
  });
  test("workspace-scoped (tenant-isolation guardrail needs the column)", () => {
    expect(executable).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
  });
  test("enabled flag so a client can pause without un-enrolling", () => {
    expect(executable).toMatch(/enabled\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/i);
  });
  test("RLS enabled", () => {
    expect(executable).toMatch(/ENABLE ROW LEVEL SECURITY/i);
  });
  test("has a paired down migration that drops the table", () => {
    expect(fs.readFileSync(DOWN, "utf-8")).toMatch(/DROP TABLE IF EXISTS instinct_ai_code_watched_repos/i);
  });
});
