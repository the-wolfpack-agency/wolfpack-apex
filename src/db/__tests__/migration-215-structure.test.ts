/** Structural invariant test for 215_governance_alerts.sql.
 *
 * 215 adds instinct_governance_alerts: the dedupe ledger behind the governance
 * drift alerting (src/lib/ogiam/governance-alerts.ts). One row per distinct
 * regression, keyed on (workspace_id, alert_kind, fingerprint) so the same
 * condition never re-alerts. It must:
 *   - create the table idempotently (CREATE TABLE IF NOT EXISTS),
 *   - use TEXT id + TEXT workspace_id (schema-guard parity with 210-214),
 *   - carry the (workspace_id, alert_kind, fingerprint) dedupe UNIQUE,
 *   - constrain alert_kind + severity via CHECK,
 *   - enable RLS with a permissive deny-by-default policy (migration 207-214 idiom),
 *   - run the schema-guard DO block asserting columns + RLS,
 *   - be transactional + additive,
 *   - and the paired .down.sql drops the table/index/policy.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "215_governance_alerts.sql"), "utf-8");
const DOWN_PATH = join(DIR, "215_governance_alerts.down.sql");

describe("migration 215 up", () => {
  it("creates instinct_governance_alerts idempotently", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_governance_alerts/);
  });

  it("uses TEXT id + TEXT workspace_id (schema-guard parity)", () => {
    expect(UP).toMatch(/id\s+TEXT\s+PRIMARY KEY/);
    expect(UP).toMatch(/workspace_id\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/instinct_governance_alerts\.id must be TEXT/);
    expect(UP).toMatch(/instinct_governance_alerts\.workspace_id must be TEXT/);
    expect(UP).not.toMatch(/workspace_id\s+UUID/i);
    expect(UP).not.toMatch(/\bid\s+UUID/i);
  });

  it("carries the (workspace_id, alert_kind, fingerprint) dedupe UNIQUE", () => {
    expect(UP).toMatch(/alert_kind\s+TEXT/);
    expect(UP).toMatch(/fingerprint\s+TEXT/);
    expect(UP).toMatch(
      /UNIQUE \(workspace_id, alert_kind, fingerprint\)/,
    );
  });

  it("constrains alert_kind + severity via CHECK", () => {
    expect(UP).toMatch(/instinct_governance_alerts_kind_chk/);
    expect(UP).toMatch(/redteam_passrate_drop/);
    expect(UP).toMatch(/redteam_new_vuln/);
    expect(UP).toMatch(/new_ungoverned_surface/);
    expect(UP).toMatch(/instinct_governance_alerts_severity_chk/);
    expect(UP).toMatch(/CHECK \(severity IN \('low', 'medium', 'high', 'critical'\)\)/);
  });

  it("enables RLS with a permissive deny-by-default policy", () => {
    expect(UP).toMatch(
      /ALTER TABLE instinct_governance_alerts ENABLE ROW LEVEL SECURITY/,
    );
    expect(UP).toMatch(
      /CREATE POLICY instinct_governance_alerts_all ON instinct_governance_alerts/,
    );
    expect(UP).toMatch(/USING \(true\) WITH CHECK \(true\)/);
  });

  it("runs the schema-guard DO block asserting columns + RLS", () => {
    expect(UP).toMatch(/DO \$\$/);
    expect(UP).toMatch(/instinct_governance_alerts missing expected columns/);
    expect(UP).toMatch(
      /RLS not enabled on instinct_governance_alerts/,
    );
  });

  it("guards its index with IF NOT EXISTS", () => {
    expect(UP).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_governance_alerts_workspace_created/,
    );
  });

  it("is additive + transactional (no drops/deletes; BEGIN/COMMIT)", () => {
    expect(UP).toMatch(/BEGIN;/);
    expect(UP).toMatch(/COMMIT;/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DROP COLUMN/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
  });
});

describe("migration 215 down", () => {
  it("exists and drops the table, index, and policy idempotently", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    const down = readFileSync(DOWN_PATH, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_governance_alerts/);
    expect(down).toMatch(
      /DROP INDEX IF EXISTS idx_governance_alerts_workspace_created/,
    );
    expect(down).toMatch(
      /DROP POLICY IF EXISTS instinct_governance_alerts_all/,
    );
  });
});
