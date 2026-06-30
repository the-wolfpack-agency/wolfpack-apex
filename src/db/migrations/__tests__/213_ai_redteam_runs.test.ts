/**
 * Shape guard for 213_ai_redteam_runs.sql (offline; no DB). TEXT id + TEXT
 * workspace_id (schema-guard parity, never UUID), a risk CHECK, JSONB findings,
 * the (workspace, created_at) index, RLS tripwire, idempotency, paired down.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "213_ai_redteam_runs.sql");
const DOWN = path.resolve(__dirname, "..", "213_ai_redteam_runs.down.sql");

describe("213_ai_redteam_runs.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_ai_redteam_runs idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_ai_redteam_runs/i);
  });

  test("id and workspace_id are TEXT (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
    expect(sql).not.toMatch(/workspace_id\s+UUID/i);
  });

  test("risk is constrained and findings is JSONB", () => {
    expect(sql).toMatch(/CHECK \(risk IN \('low', 'medium', 'high', 'critical'\)\)/i);
    expect(sql).toMatch(/findings\s+JSONB\s+NOT NULL/i);
    expect(sql).toMatch(/vulns\s+INT\s+NOT NULL/i);
  });

  test("indexes (workspace_id, created_at)", () => {
    expect(sql).toMatch(/idx_ai_redteam_runs_workspace_created\s+ON instinct_ai_redteam_runs \(workspace_id, created_at DESC\)/i);
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE instinct_ai_redteam_runs ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT id + workspace_id, RLS on)", () => {
    expect(sql).toMatch(/id must be TEXT/i);
    expect(sql).toMatch(/workspace_id must be TEXT/i);
    expect(sql).toMatch(/RLS not enabled on instinct_ai_redteam_runs/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_ai_redteam_runs/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_ai_redteam_runs_workspace_created/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_ai_redteam_runs_all/i);
  });
});
