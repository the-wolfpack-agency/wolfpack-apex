/**
 * Structural invariants for migration 216_admin_mfa.
 *
 * Runs against the raw SQL text only (no live DB). Asserts the opt-in,
 * non-enforcing admin-MFA enrollment table has the expected TEXT id /
 * user_id / workspace_id, encrypted_secret + confirmed_at + recovery_code_hashes
 * columns, CHECK constraints, a guarded index, RLS enabled with the tripwire
 * policy + DO-block assertion, and a paired idempotent down migration.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const upSql = readFileSync(join(MIGRATIONS_DIR, "216_admin_mfa.sql"), "utf8");
const downSql = readFileSync(join(MIGRATIONS_DIR, "216_admin_mfa.down.sql"), "utf8");

const TABLE = "instinct_admin_mfa";

describe("migration 216 — admin MFA enrollment", () => {
  it("documents the OPT-IN / NON-ENFORCING safety contract in the header", () => {
    expect(upSql).toMatch(/OPT-IN/);
    expect(upSql).toMatch(/NON-ENFORCING/);
  });

  it("wraps the body in BEGIN/COMMIT", () => {
    expect(upSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });

  it("creates the table idempotently (IF NOT EXISTS)", () => {
    expect(upSql).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${TABLE}`));
  });

  it("declares id/user_id/workspace_id as TEXT", () => {
    expect(upSql).toMatch(/\bid\s+TEXT\s+PRIMARY\s+KEY/);
    expect(upSql).toMatch(/\buser_id\s+TEXT\s+NOT\s+NULL/);
    expect(upSql).toMatch(/\bworkspace_id\s+TEXT\s+NOT\s+NULL/);
  });

  it("declares encrypted_secret, confirmed_at, recovery_code_hashes, timestamps", () => {
    expect(upSql).toMatch(/\bencrypted_secret\s+TEXT\s+NOT\s+NULL/);
    expect(upSql).toMatch(/\bconfirmed_at\s+TIMESTAMPTZ/);
    expect(upSql).toMatch(/\brecovery_code_hashes\s+TEXT\[\]/);
    expect(upSql).toMatch(/\bcreated_at\s+TIMESTAMPTZ/);
    expect(upSql).toMatch(/\bupdated_at\s+TIMESTAMPTZ/);
  });

  it("enforces one enrollment per user (UNIQUE user_id) and a secret CHECK", () => {
    expect(upSql).toMatch(/UNIQUE\s*\(user_id\)/);
    expect(upSql).toMatch(/CHECK\s*\(encrypted_secret/);
  });

  it("creates a guarded per-workspace/user index", () => {
    expect(upSql).toMatch(
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS[\\s\\S]*?ON\\s+${TABLE}`),
    );
  });

  it("enables RLS with the deny-by-default tripwire policy", () => {
    expect(upSql).toMatch(new RegExp(`ALTER\\s+TABLE\\s+${TABLE}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`));
    expect(upSql).toMatch(new RegExp(`CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+${TABLE}`));
    expect(upSql).toMatch(/RLS not enabled on instinct_admin_mfa/);
  });

  it("has a DO-block schema guard asserting the expected columns + TEXT ids", () => {
    expect(upSql).toMatch(/DO \$\$/);
    expect(upSql).toMatch(/missing expected columns/);
    expect(upSql).toMatch(/instinct_admin_mfa\.id must be TEXT/);
    expect(upSql).toMatch(/instinct_admin_mfa\.workspace_id must be TEXT/);
  });

  it("down migration drops policy, index, and table with IF EXISTS, wrapped in a tx", () => {
    expect(downSql).toMatch(new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS[\\s\\S]*ON\\s+${TABLE}`));
    expect(downSql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+idx_admin_mfa_workspace_user/);
    expect(downSql).toMatch(new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${TABLE}`));
    expect(downSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });
});
