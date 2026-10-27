/**
 * Shape guard for 299_forcefield_plugin_connect.sql (offline; no DB). The
 * real-Postgres proof (applies twice, the plugin connect SQL) is
 * src/db/__tests__/forcefield-self-serve-onboarding.db.test.ts.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "299_forcefield_plugin_connect.sql");
const DOWN = path.resolve(__dirname, "..", "299_forcefield_plugin_connect.down.sql");

describe("299_forcefield_plugin_connect.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");
  const executable = sql.replace(/--[^\n]*/g, "");

  test("additive and idempotent", () => {
    for (const col of ["detected_platform TEXT", "plugin_secret_sha256 TEXT", "plugin_linked_at TIMESTAMPTZ"]) {
      expect(executable).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(executable).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS forcefield_signup_requests_plugin_secret/);
    expect(executable).not.toMatch(/\bDROP\b|ADD COLUMN[^,;]*NOT NULL/i);
  });
  test("stores only a hash of the plugin secret", () => {
    expect(executable).not.toMatch(/plugin_secret\s+TEXT/);
  });
  test("has a paired down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP INDEX IF EXISTS forcefield_signup_requests_plugin_secret/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS plugin_secret_sha256/);
  });
});
