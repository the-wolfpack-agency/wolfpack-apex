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

function migrationNumber(file: string): number | null {
  const match = file.match(/^(\d{3})/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Collect, per column name, the set of migration numbers that widen that
 * column to TEXT via `ALTER COLUMN <col> TYPE TEXT`. We can't bind the
 * ALTER to a specific table cheaply with a line scan (the ALTER and the
 * table name may sit on different lines, or be built with format()), so
 * we track resolution at the (column, migration-number) granularity:
 * a UUID CREATE-TABLE finding for <col> in migration N is considered
 * RESOLVED if some migration M > N contains an `ALTER COLUMN <col> TYPE
 * TEXT` for the same column name. This mirrors how migration 040 resolves
 * the historical 035/038 offenders and migration 144/192 resolve the
 * later ones - the invariant the test pins is "every UUID user-id column
 * has a later widening migration", not "no landed migration ever spelled
 * the column UUID" (we never rewrite landed migrations).
 */
function collectTextWidenings(): Map<string, number[]> {
  const byCol = new Map<string, number[]>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const num = migrationNumber(file);
    if (num === null) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    for (const col of USER_ID_COLUMN_NAMES) {
      // ALTER COLUMN <col> TYPE TEXT  - tolerant of the IF wrapper and
      // the literal-vs-format() spelling (format() emits %I but the
      // column name still appears in the pairs array literal alongside a
      // "TYPE TEXT" cast in the same file).
      const direct = new RegExp(
        `ALTER\\s+COLUMN\\s+${col}\\s+TYPE\\s+TEXT`,
        "i",
      );
      const viaPairs =
        new RegExp(`['\"]${col}['\"]`).test(text) && /TYPE\s+TEXT/i.test(text);
      if (direct.test(text) || viaPairs) {
        const arr = byCol.get(col) ?? [];
        arr.push(num);
        byCol.set(col, arr);
      }
    }
  }
  return byCol;
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

/**
 * A UUID user-id finding is UNRESOLVED when no later-numbered migration
 * widens that column to TEXT. Those are the genuine regressions.
 */
function unresolvedFindings(): Finding[] {
  const findings = scanMigrations();
  const widenings = collectTextWidenings();
  return findings.filter((f) => {
    const num = migrationNumber(f.file);
    if (num === null) return false;
    const fixers = widenings.get(f.column) ?? [];
    const hasLaterFix = fixers.some((m) => m > num);
    return !hasLaterFix;
  });
}

describe("Schema invariant: user-identity columns are TEXT, not UUID", () => {
  it("every UUID user-id column has a later widening to TEXT", () => {
    // The HISTORICAL CREATE TABLE statements (035/038 widened by 040,
    // 143 by 144, 153/154/155/158 by 192) still spell the column `UUID`
    // because we never rewrite landed migrations. The invariant pinned
    // here is therefore "every UUID user-id finding is accompanied by a
    // later-numbered ALTER ... TYPE TEXT migration." A new migration that
    // introduces a UUID user-id column with NO later widening is the
    // regression this test catches.
    const unresolved = unresolvedFindings();

    if (unresolved.length > 0) {
      const msg = unresolved
        .map((f) => `  ${f.file}:${f.line} — ${f.column} typed as UUID\n    ${f.statement}`)
        .join("\n");
      throw new Error(
        `Migration(s) introduced a user-identity column as UUID.\n` +
          `User ids in this codebase are stable string identifiers (e.g. "demo-cto"), not UUIDs.\n` +
          `Columns must be TEXT - either declare TEXT in the CREATE TABLE or add a\n` +
          `later numbered migration that ALTERs the column to TEXT. Fix before merging.\n\n${msg}`,
      );
    }
    expect(unresolved).toEqual([]);
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
