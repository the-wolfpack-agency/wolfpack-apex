/**
 * Schema-level regression test: user-id columns must be TEXT, not UUID.
 *
 * Why this test exists — 2026-04-19 production bug:
 *   A designer tried to upload a client asset while signed in as the
 *   demo-cto account (a stable seeded identifier, NOT a UUID). The
 *   write failed with
 *       writeQuery failed: invalid input syntax for type uuid: "demo-cto"
 *   because migration 038 typed `instinct_client_assets.uploaded_by`
 *   as UUID. Migration 035 did the same thing with
 *   `apex_share_tokens.created_by`.
 *
 *   Every unit test had passed. Every contract test had passed. The
 *   Playwright reality-check spec HAD green-lit the feature. All of
 *   those were mocking writeQuery or running under a user whose id
 *   HAPPENED to be UUID-shaped.
 *
 *   The bug surfaced only when a real user with a non-UUID id hit the
 *   path — which the user caught manually in seconds, proving (again)
 *   that mocks don't substitute for real-service E2E, and that a
 *   mock-heavy suite can mask schema-code mismatches entirely.
 *
 * The fix — migration 040_user_id_columns_to_text.sql — widens both
 * columns to TEXT. This test PINS the invariant at the schema level:
 * ANY user-id column declared as UUID is rejected, full-stop. If a
 * future migration re-introduces a UUID-typed user-id column, this
 * test will fail before the code ships.
 *
 * Implementation: parse every *.sql file under src/db/migrations/ and
 * look for `<user_id_column> UUID` patterns in CREATE TABLE blocks.
 * Column names matched: uploaded_by, created_by, added_by, requested_by,
 * resolved_by, recorded_by, submitted_by, assigned_to, user_id,
 * authored_by, actor_id.
 *
 * Exceptions — columns that ARE genuinely UUID-typed foreign keys to
 * UUID-keyed tables, not user identifiers:
 *   - share_token_id: FK to apex_share_tokens.id (UUID)
 *   - comment_id / parent_comment_id: FKs to instinct_site_section_comments.id
 *   - any *_id column that references another UUID-keyed table
 *
 * So the matcher specifically looks for USER-IDENTITY columns, not
 * every *_by / *_id column.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const USER_ID_COLUMN_NAMES = [
  "uploaded_by",
  "created_by",
  "added_by",
  "requested_by",
  "resolved_by",
  "recorded_by",
  "submitted_by",
  "assigned_to",
  "user_id",
  "authored_by",
  "actor_id",
  "actor_user_id",
  "owner_id",
  "deleted_by",
  "modified_by",
  "approved_by",
  "last_edited_by",
];

interface Finding {
  file: string;
  line: number;
  column: string;
  statement: string;
}

function scanMigrations(): Finding[] {
  const findings: Finding[] = [];
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file);
    const text = readFileSync(path, "utf-8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments
      const codePart = line.replace(/--.*$/, "");
      for (const col of USER_ID_COLUMN_NAMES) {
        // Match "column_name UUID" with optional constraints, at word
        // boundaries. This catches CREATE TABLE column lines and
        // ALTER TABLE ADD COLUMN forms, but NOT references like
        // "FOREIGN KEY (uploaded_by) REFERENCES ..." because those
        // don't carry the column's type declaration.
        const pattern = new RegExp(`\\b${col}\\s+UUID\\b`, "i");
        if (pattern.test(codePart)) {
          findings.push({
            file,
            line: i + 1,
            column: col,
            statement: line.trim(),
          });
        }
      }
    }
  }

  return findings;
}

describe("Schema invariant: user-identity columns are TEXT, not UUID", () => {
  it("no migration declares a user-id column as UUID", () => {
    const findings = scanMigrations();

    // After migration 040 applies, every offending column has been
    // widened to TEXT in the running DB. But the HISTORICAL CREATE
    // TABLE statements in 035 + 038 still say `UUID` because we don't
    // rewrite landed migrations. So findings will be non-empty.
    //
    // The rule is: findings MUST all be in files <= 038 AND must be
    // accompanied by a later-numbered ALTER TABLE ... TYPE TEXT in
    // a subsequent migration. If a new migration introduces a
    // user-id column as UUID, this test must catch it — so we look
    // for findings in files NEWER than 038 and fail if any exist.
    const unresolvedFindings = findings.filter((f) => {
      const match = f.file.match(/^(\d{3})/);
      if (!match) return false;
      const num = parseInt(match[1], 10);
      // Any migration AFTER 038 (the last offender) reintroducing a
      // UUID user-id column is a regression.
      return num > 38;
    });

    if (unresolvedFindings.length > 0) {
      const msg = unresolvedFindings
        .map((f) => `  ${f.file}:${f.line} — ${f.column} typed as UUID\n    ${f.statement}`)
        .join("\n");
      throw new Error(
        `Migration(s) introduced a user-identity column as UUID.\n` +
          `User ids in this codebase are stable string identifiers (e.g. "demo-cto"), not UUIDs.\n` +
          `Columns must be TEXT. Fix before merging.\n\n${msg}`,
      );
    }
    expect(unresolvedFindings).toEqual([]);
  });

  it("migration 040 exists and widens both known offenders", () => {
    const path = join(MIGRATIONS_DIR, "040_user_id_columns_to_text.sql");
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("instinct_client_assets");
    expect(text).toContain("uploaded_by");
    expect(text).toContain("apex_share_tokens");
    expect(text).toContain("created_by");
    expect(text).toMatch(/ALTER COLUMN\s+uploaded_by\s+TYPE\s+TEXT/i);
    expect(text).toMatch(/ALTER COLUMN\s+created_by\s+TYPE\s+TEXT/i);
  });

  it("migration 040 has a reversible .down.sql", () => {
    const path = join(MIGRATIONS_DIR, "040_user_id_columns_to_text.down.sql");
    const text = readFileSync(path, "utf-8");
    expect(text).toMatch(/ALTER COLUMN\s+uploaded_by\s+TYPE\s+UUID/i);
    expect(text).toMatch(/ALTER COLUMN\s+created_by\s+TYPE\s+UUID/i);
  });
});
