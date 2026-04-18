/**
 * Migration 029_site_brief_edits — schema + idempotency contract.
 *
 * We don't spin up real Postgres in unit tests (see audit-log-immutable
 * for the same pattern). Instead we parse the SQL and enforce the rules
 * that would otherwise only fail in production:
 *
 *   1. Idempotent on every re-run (IF NOT EXISTS guards on both table
 *      and indexes).
 *   2. Every column the route handler reads/writes is declared, with
 *      the right type.
 *   3. instinct_site_brief_edits view alias exists so the naming
 *      convention stays consistent with migration 014.
 *   4. Foreign key to apex_site_projects cascades on delete (an
 *      archived site shouldn't orphan its edits).
 */

import { readFileSync } from "fs";
import { join } from "path";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "db",
  "migrations",
  "029_site_brief_edits.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 029 — apex_site_brief_edits", () => {
  it("creates the table with IF NOT EXISTS (idempotent)", () => {
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+apex_site_brief_edits/i);
  });

  it("declares all columns the route handler reads/writes", () => {
    const required: Array<{ name: string; type: RegExp }> = [
      { name: "id", type: /\bTEXT\b/i },
      { name: "project_id", type: /\bTEXT\b/i },
      { name: "user_id", type: /\bTEXT\b/i },
      { name: "user_role", type: /\bTEXT\b/i },
      { name: "instruction", type: /\bTEXT\b/i },
      { name: "patch", type: /\bJSONB\b/i },
      { name: "brief_before_hash", type: /\bTEXT\b/i },
      { name: "brief_after_hash", type: /\bTEXT\b/i },
      { name: "accepted", type: /\bBOOLEAN\b/i },
      { name: "rejection_reason", type: /\bTEXT\b/i },
      { name: "latency_ms", type: /\bINT/i },
      { name: "tokens_in", type: /\bINT/i },
      { name: "tokens_out", type: /\bINT/i },
      { name: "cost_usd", type: /NUMERIC/i },
      { name: "model", type: /\bTEXT\b/i },
      { name: "created_at", type: /TIMESTAMPTZ/i },
      { name: "decided_at", type: /TIMESTAMPTZ/i },
    ];
    for (const col of required) {
      // Column line must exist AND declare the expected type near it.
      const re = new RegExp(`\\b${col.name}\\b[^,\\n]*${col.type.source}`, "i");
      expect(sql).toMatch(re);
    }
  });

  it("cascades foreign key to apex_site_projects so archive clean-up works", () => {
    expect(sql).toMatch(
      /project_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+apex_site_projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
    );
  });

  it("creates indexes with IF NOT EXISTS (idempotent)", () => {
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w*project\w*\s+ON\s+apex_site_brief_edits\s*\(\s*project_id/i);
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w*accepted\w*\s+ON\s+apex_site_brief_edits\s*\(\s*accepted/i);
  });

  it("creates the instinct_site_brief_edits view alias (naming parity with 014)", () => {
    expect(sql).toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+instinct_site_brief_edits\s+AS\s+SELECT/i,
    );
    expect(sql).toMatch(/FROM\s+apex_site_brief_edits/i);
  });

  it("accepted defaults to NULL so we can distinguish 'undecided' from 'rejected'", () => {
    // Extract the accepted column declaration
    const match = sql.match(/accepted\s+BOOLEAN[^,\n]*/i);
    expect(match).not.toBeNull();
    // It must NOT declare a DEFAULT (meaning implicit NULL) AND must
    // NOT declare NOT NULL. "accepted=NULL" is the signal that a user
    // still has the edit in-flight.
    const decl = match![0];
    expect(decl).not.toMatch(/NOT\s+NULL/i);
    expect(decl).not.toMatch(/DEFAULT\s+(TRUE|FALSE)/i);
  });
});
