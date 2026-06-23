/**
 * Structural invariant test for 171_agent_principals.sql.
 *
 * Locks the agent principal table shape: additive and idempotent, an agent has
 * a role and an always-present owner (the accountable human), a lifecycle state,
 * an identity provider, and only a HASH of the onboarding secret (never the raw
 * value). The paired down drops the table.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "migrations");
const UP = readFileSync(join(DIR, "171_agent_principals.sql"), "utf-8");
const DOWN_PATH = join(DIR, "171_agent_principals.down.sql");

describe("migration 171 up", () => {
  it("creates instinct_agents idempotently and additively", () => {
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS instinct_agents/);
    expect(UP).not.toMatch(/DROP TABLE/i);
    expect(UP).not.toMatch(/DELETE FROM/i);
    expect(UP).not.toMatch(/ALTER TABLE/i);
  });

  it("carries role, an always-present owner, state, and identity provider", () => {
    expect(UP).toMatch(/role\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/owner_user_id\s+TEXT\s+NOT NULL/);
    expect(UP).toMatch(/state\s+TEXT\s+NOT NULL\s+DEFAULT 'invited'/);
    expect(UP).toMatch(/identity_provider\s+TEXT\s+NOT NULL\s+DEFAULT 'local'/);
  });

  it("stores only the onboarding secret HASH, never a raw secret column", () => {
    expect(UP).toMatch(/onboarding_secret_hash\s+TEXT/);
    expect(UP).not.toMatch(/onboarding_secret\s+TEXT/); // no raw-secret column
  });

  it("enforces one agent name per workspace", () => {
    expect(UP).toMatch(/UNIQUE\s*\(\s*workspace_id\s*,\s*name\s*\)/);
  });
});

describe("migration 171 down", () => {
  it("drops the table", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(readFileSync(DOWN_PATH, "utf-8")).toMatch(/DROP TABLE IF EXISTS instinct_agents/);
  });
});
