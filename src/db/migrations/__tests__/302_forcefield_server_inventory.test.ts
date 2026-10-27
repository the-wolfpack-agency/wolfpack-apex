/**
 * Shape guard for 302_forcefield_server_inventory.sql (offline; no DB). The
 * real-Postgres proof (applies twice, the lib SQL) is
 * src/db/__tests__/forcefield-server-inventory.db.test.ts.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "302_forcefield_server_inventory.sql");
const DOWN = path.resolve(__dirname, "..", "302_forcefield_server_inventory.down.sql");

describe("302_forcefield_server_inventory.sql", () => {
  const executable = fs.readFileSync(UP, "utf-8").replace(/--[^\n]*/g, "");

  test("additive and idempotent", () => {
    expect(executable).toMatch(/CREATE TABLE IF NOT EXISTS forcefield_server_inventory/);
    expect(executable).toMatch(/CREATE INDEX IF NOT EXISTS forcefield_server_inventory_received_at/);
    expect(executable).not.toMatch(/\bDROP\b|\bALTER TABLE\b/i);
  });
  test("one row per tenant, removed with the tenant", () => {
    expect(executable).toMatch(/tenant_id\s+UUID PRIMARY KEY REFERENCES forcefield_tenants\(id\) ON DELETE CASCADE/);
  });
  test("holds versions only: no visitor, content or credential columns", () => {
    const cols = [...executable.matchAll(/^\s{2}([a-z_]+)\s+(TEXT|JSONB|TIMESTAMPTZ|INTEGER|UUID|TEXT\[\])/gm)].map((m) => m[1]).sort();
    expect(cols).toEqual(["alerted_keys", "first_received_at", "php_version", "plugin_version", "plugins", "received_at", "reports", "server_software", "tenant_id", "wordpress_version"].sort());
  });
  test("has a paired down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS forcefield_server_inventory/);
  });
});
