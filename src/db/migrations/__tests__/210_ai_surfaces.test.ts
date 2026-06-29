/**
 * Shape guard for 210_ai_surfaces.sql (offline; no DB). Asserts the AI surface
 * inventory: TEXT id + TEXT workspace_id (schema-guard parity, never UUID), a
 * risk CHECK, governed default false, JSONB evidence, the (workspace,target) and
 * (workspace,governed) indexes, RLS tripwire, idempotency, and a paired down.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "210_ai_surfaces.sql");
const DOWN = path.resolve(__dirname, "..", "210_ai_surfaces.down.sql");

describe("210_ai_surfaces.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_ai_surfaces idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_ai_surfaces/i);
  });

  test("id and workspace_id are TEXT (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
    expect(sql).not.toMatch(/workspace_id\s+UUID/i);
  });

  test("governed defaults false and risk is constrained", () => {
    expect(sql).toMatch(/governed\s+BOOLEAN\s+NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/CHECK \(risk IN \('low', 'medium', 'high', 'critical'\)\)/i);
    expect(sql).toMatch(/evidence\s+JSONB\s+NOT NULL/i);
  });

  test("indexes (workspace,target) and (workspace,governed)", () => {
    expect(sql).toMatch(/idx_ai_surfaces_workspace_target\s+ON instinct_ai_surfaces \(workspace_id, target\)/i);
    expect(sql).toMatch(/idx_ai_surfaces_workspace_governed\s+ON instinct_ai_surfaces \(workspace_id, governed\)/i);
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(/ALTER TABLE instinct_ai_surfaces ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /CREATE POLICY instinct_ai_surfaces_all ON instinct_ai_surfaces\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT id + workspace_id, RLS on)", () => {
    expect(sql).toMatch(/id must be TEXT/i);
    expect(sql).toMatch(/workspace_id must be TEXT/i);
    expect(sql).toMatch(/RLS not enabled on instinct_ai_surfaces/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_ai_surfaces/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS idx_ai_surfaces_workspace_target/i);
    expect(down).toMatch(/DROP POLICY IF EXISTS instinct_ai_surfaces_all/i);
  });
});
