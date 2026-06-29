/**
 * Shape guard for 209_ogiam_enforcement_policy.sql (offline; no DB).
 *
 * Asserts the per-capability enforcement-posture table: composite PK
 * (workspace_id, capability), a TEXT workspace_id (schema-guard parity, never
 * UUID), a mode CHECK constrained to monitor/enforce, the workspace index, RLS
 * enabled with a permissive policy (deny-by-default tripwire), idempotency, and a
 * paired reversible .down.sql.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "209_ogiam_enforcement_policy.sql");
const DOWN = path.resolve(__dirname, "..", "209_ogiam_enforcement_policy.down.sql");

describe("209_ogiam_enforcement_policy.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates ogiam_enforcement_policy idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ogiam_enforcement_policy/i);
  });

  test("workspace_id is TEXT (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
    expect(sql).not.toMatch(/workspace_id\s+UUID/i);
  });

  test("composite primary key on (workspace_id, capability)", () => {
    expect(sql).toMatch(/PRIMARY KEY \(workspace_id, capability\)/i);
  });

  test("mode is constrained to monitor/enforce", () => {
    expect(sql).toMatch(/mode\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/CHECK \(mode IN \('monitor', 'enforce'\)\)/i);
  });

  test("indexes workspace_id for the resolution read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_ogiam_enforcement_policy_workspace\s+ON ogiam_enforcement_policy \(workspace_id\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE ogiam_enforcement_policy ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY ogiam_enforcement_policy_all ON ogiam_enforcement_policy\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT workspace_id, RLS on)", () => {
    expect(sql).toMatch(/workspace_id must be TEXT/i);
    expect(sql).toMatch(/RLS not enabled on ogiam_enforcement_policy/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS ogiam_enforcement_policy/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_ogiam_enforcement_policy_workspace/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS ogiam_enforcement_policy_all/i);
  });
});
