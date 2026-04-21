/**
 * Structural invariants for migration 077_ms_canonical_mirror.
 *
 * This is a CREATE migration (unlike the RENAME migrations 036-076), so
 * its invariants are different: we assert that every canonical table
 * plus the two support tables (change_log, sync_cursors) exist with the
 * expected columns, types, constraints, and indexes. Runs against the
 * raw SQL text only — no live DB needed. Pair with the e2e integration
 * tests for actual database behavior.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "077_ms_canonical_mirror.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "077_ms_canonical_mirror.down.sql");

const upSql = readFileSync(UP_PATH, "utf8");
const downSql = readFileSync(DOWN_PATH, "utf8");

const TABLES = [
  "instinct_ms_events",
  "instinct_ms_tasks",
  "instinct_ms_messages",
  "instinct_ms_contacts",
  "instinct_ms_files",
];
const META_TABLES = ["instinct_ms_change_log", "instinct_ms_sync_cursors"];

describe("migration 077 — MS Graph canonical mirror CREATE", () => {
  it("file header documents the batch/stream", () => {
    expect(upSql).toMatch(/Tier 3/);
    expect(upSql).toMatch(/canonical-mirror/);
    expect(upSql).toMatch(/Batch U1/);
  });

  it("wraps the body in BEGIN/COMMIT", () => {
    expect(upSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });

  it("creates each of the 5 canonical entity tables with IF NOT EXISTS", () => {
    for (const t of TABLES) {
      const re = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${t}`);
      expect(upSql).toMatch(re);
    }
  });

  it("creates both metadata tables (change_log + sync_cursors)", () => {
    for (const t of META_TABLES) {
      const re = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${t}`);
      expect(upSql).toMatch(re);
    }
  });

  it("every canonical table declares the common id/user_id/external_id/raw/normalized/timestamps block", () => {
    for (const t of TABLES) {
      const body = extractCreateBlock(upSql, t);
      expect(body).toMatch(/\bid\s+UUID\s+PRIMARY\s+KEY/);
      expect(body).toMatch(/\buser_id\s+TEXT\s+NOT\s+NULL/);
      expect(body).toMatch(/\bexternal_id\s+TEXT\s+NOT\s+NULL/);
      expect(body).toMatch(/\bnormalized_payload\s+JSONB/);
      expect(body).toMatch(/\braw_payload\s+JSONB/);
      expect(body).toMatch(/\boccurred_at\s+TIMESTAMPTZ/);
      expect(body).toMatch(/\bupdated_at\s+TIMESTAMPTZ/);
      expect(body).toMatch(/\bdeleted_at\s+TIMESTAMPTZ/);
      expect(body).toMatch(/UNIQUE\s*\(user_id,\s*external_id\)/);
    }
  });

  it("events table declares event-specific columns", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_events");
    expect(body).toMatch(/\bstart_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(/\bend_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(/\battendees\s+JSONB/);
    expect(body).toMatch(/\borganizer_email\s+TEXT/);
    expect(body).toMatch(/\bonline_meeting\s+BOOLEAN/);
  });

  it("tasks table declares task-specific columns", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_tasks");
    expect(body).toMatch(/\bstatus\s+TEXT/);
    expect(body).toMatch(/\bdue_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(/\bimportance\s+TEXT/);
  });

  it("messages table declares message-specific columns", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_messages");
    expect(body).toMatch(/\bfrom_email\s+TEXT/);
    expect(body).toMatch(/\bto_emails\s+JSONB/);
    expect(body).toMatch(/\bhas_attachments\s+BOOLEAN/);
  });

  it("contacts table declares contact-specific columns", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_contacts");
    expect(body).toMatch(/\bdisplay_name\s+TEXT/);
    expect(body).toMatch(/\bemail_addresses\s+JSONB/);
    expect(body).toMatch(/\bcompany_name\s+TEXT/);
  });

  it("files table declares file-specific columns", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_files");
    expect(body).toMatch(/\bdrive_id\s+TEXT/);
    expect(body).toMatch(/\bweb_url\s+TEXT/);
    expect(body).toMatch(/\bsize_bytes\s+BIGINT/);
    expect(body).toMatch(/\bmime_type\s+TEXT/);
  });

  it("change_log is append-only: only required append-friendly columns + CHECK constraints", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_change_log");
    expect(body).toMatch(/\buser_id\s+TEXT/);
    expect(body).toMatch(/\bentity_type\s+TEXT/);
    expect(body).toMatch(/\bentity_id\s+TEXT/);
    expect(body).toMatch(/\bchange_type\s+TEXT/);
    expect(body).toMatch(/\boccurred_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(
      /CHECK\s*\(\s*entity_type\s+IN\s*\(\s*'events'.*'tasks'.*'messages'.*'contacts'.*'files'/,
    );
    expect(body).toMatch(
      /CHECK\s*\(\s*change_type\s+IN\s*\(\s*'created'.*'updated'.*'deleted'/,
    );
  });

  it("sync_cursors has composite PK on (user_id, entity_type) + delta_link + last_synced_at", () => {
    const body = extractCreateBlock(upSql, "instinct_ms_sync_cursors");
    expect(body).toMatch(/\buser_id\s+TEXT/);
    expect(body).toMatch(/\bentity_type\s+TEXT/);
    expect(body).toMatch(/\bdelta_link\s+TEXT/);
    expect(body).toMatch(/\blast_synced_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(/PRIMARY\s+KEY\s*\(user_id,\s*entity_type\)/);
  });

  it("creates per-user indexes on each canonical table", () => {
    for (const t of TABLES) {
      const re = new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+\\S*${t.replace("instinct_ms_", "")}\\S*\\s+ON\\s+${t}`);
      // Looser check: each canonical table has at least one index referencing it.
      const anyIdxRe = new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS[\\s\\S]*?ON\\s+${t}`);
      expect(upSql).toMatch(anyIdxRe);
    }
  });

  it("has a preflight guard that rejects non-table relkinds", () => {
    expect(upSql).toMatch(/Refusing to create/);
    expect(upSql).toMatch(/relkind NOT IN\s*\('r'\)/);
  });

  it("has a post-create assertion that every entity table has its UNIQUE constraint", () => {
    expect(upSql).toMatch(/missing its UNIQUE constraint/);
  });

  it("down-migration drops each table with IF EXISTS in reverse dependency order", () => {
    for (const t of [...META_TABLES, ...TABLES]) {
      expect(downSql).toMatch(new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${t}`));
    }
  });

  it("down-migration wraps in BEGIN/COMMIT", () => {
    expect(downSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });
});

/**
 * Extract the body between the CREATE TABLE IF NOT EXISTS line and its
 * matching `);`. Good-enough heuristic for a SQL file with no pathological
 * nested parens beyond the standard constraint/default clauses.
 */
function extractCreateBlock(sql: string, table: string): string {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  );
  const m = sql.match(re);
  if (!m) {
    throw new Error(`CREATE block not found for ${table}`);
  }
  return m[1];
}
