/**
 * Shape guard for 214_compliance_reports.sql (offline; no DB). TEXT id + TEXT
 * workspace_id (schema-guard parity, never UUID), a framework CHECK, JSONB report,
 * the (workspace, created_at) index, RLS tripwire, idempotency, paired down.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "214_compliance_reports.sql");
const DOWN = path.resolve(__dirname, "..", "214_compliance_reports.down.sql");

describe("214_compliance_reports.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_compliance_reports idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_compliance_reports/i);
  });

  test("id and workspace_id are TEXT (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
    expect(sql).not.toMatch(/workspace_id\s+UUID/i);
  });

  test("framework is constrained and report is JSONB", () => {
    expect(sql).toMatch(/CHECK \(framework IN \('SOC2', 'ISO42001', 'NIST_AI_RMF', 'EU_AI_ACT'\)\)/i);
    expect(sql).toMatch(/report\s+JSONB\s+NOT NULL/i);
    expect(sql).toMatch(/coverage\s+NUMERIC\s+NOT NULL/i);
  });

  test("indexes (workspace_id, created_at)", () => {
    expect(sql).toMatch(/idx_compliance_reports_workspace_created\s+ON instinct_compliance_reports \(workspace_id, created_at DESC\)/i);
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE instinct_compliance_reports ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY instinct_compliance_reports_all ON instinct_compliance_reports\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT id + workspace_id, RLS on)", () => {
    expect(sql).toMatch(/id must be TEXT/i);
    expect(sql).toMatch(/workspace_id must be TEXT/i);
    expect(sql).toMatch(/RLS not enabled on instinct_compliance_reports/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_compliance_reports/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_compliance_reports_workspace_created/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_compliance_reports_all/i);
  });
});
