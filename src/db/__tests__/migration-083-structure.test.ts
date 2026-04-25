/**
 * Structural invariants for migration 083_meeting_insights.
 *
 * Static SQL test — runs against the file text only, no live DB. Pair
 * with the API integration tests for runtime behavior. Mirrors the
 * 077 / 082 structure tests.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "083_meeting_insights.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "083_meeting_insights.down.sql");

const upSql = readFileSync(UP_PATH, "utf8");
const downSql = readFileSync(DOWN_PATH, "utf8");

const TABLES = [
  "instinct_meeting_feeds",
  "instinct_meeting_artifacts",
  "instinct_meeting_messages",
  "instinct_meeting_attachments",
  "instinct_meeting_exceptions",
];

describe("migration 083 — meeting-insights CREATE", () => {
  it("file header documents the stream", () => {
    expect(upSql).toMatch(/Stream A/);
    expect(upSql).toMatch(/meeting-insights/);
  });

  it("wraps the body in BEGIN/COMMIT", () => {
    expect(upSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });

  it("creates each of the 5 tables with IF NOT EXISTS", () => {
    for (const t of TABLES) {
      expect(upSql).toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${t}`),
      );
    }
  });

  it("feeds table declares slug UNIQUE + slug shape CHECK", () => {
    expect(upSql).toMatch(/slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/);
    expect(upSql).toMatch(/instinct_meeting_feeds_slug_chk/);
  });

  it("feeds table declares filters JSONB with empty default", () => {
    expect(upSql).toMatch(/filters\s+JSONB\s+NOT\s+NULL\s+DEFAULT/);
  });

  it("artifacts table declares parse_status CHECK with no silent-fall-through", () => {
    expect(upSql).toMatch(/instinct_meeting_artifacts_status_chk/);
    expect(upSql).toMatch(
      /CHECK\s*\(parse_status\s+IN\s*\('pending'\s*,\s*'processed'\s*,\s*'error_quarantined'\s*,\s*'needs_review'\)\)/,
    );
  });

  it("artifacts table has the (source_message_id, content_sha256) UNIQUE idempotency index", () => {
    expect(upSql).toMatch(
      /uq_instinct_meeting_artifacts_dedup[\s\S]*\(source_message_id,\s*content_sha256\)/,
    );
  });

  it("messages table is keyed by (feed_id, source_message_id) for idempotency", () => {
    expect(upSql).toMatch(
      /uq_instinct_meeting_messages_feed_msg[\s\S]*\(feed_id,\s*source_message_id\)/,
    );
  });

  it("messages table cascades from feeds + artifacts on delete", () => {
    expect(upSql).toMatch(
      /feed_id\s+UUID\s+NOT\s+NULL[\s\S]*REFERENCES\s+instinct_meeting_feeds\(id\)\s+ON\s+DELETE\s+CASCADE/,
    );
    expect(upSql).toMatch(
      /artifact_id\s+UUID\s+NOT\s+NULL[\s\S]*REFERENCES\s+instinct_meeting_artifacts\(id\)\s+ON\s+DELETE\s+CASCADE/,
    );
  });

  it("attachments table cascades from messages and stores bytea", () => {
    expect(upSql).toMatch(
      /message_id\s+UUID\s+NOT\s+NULL[\s\S]*REFERENCES\s+instinct_meeting_messages\(id\)\s+ON\s+DELETE\s+CASCADE/,
    );
    expect(upSql).toMatch(/bytes\s+BYTEA/);
  });

  it("attachments table CHECKs extraction_status enum", () => {
    expect(upSql).toMatch(
      /CHECK\s*\(extraction_status\s+IN\s*\('extracted'\s*,\s*'unsupported_mime'\s*,\s*'error'\)\)/,
    );
  });

  it("exceptions table CHECKs kind + status + paired resolved fields", () => {
    expect(upSql).toMatch(/instinct_meeting_exceptions_kind_chk/);
    expect(upSql).toMatch(/instinct_meeting_exceptions_status_chk/);
    expect(upSql).toMatch(/instinct_meeting_exceptions_resolved_pair_chk/);
  });

  it("enables RLS on every content-bearing table", () => {
    for (const t of TABLES) {
      expect(upSql).toMatch(new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`));
    }
  });

  it("ends with a row-count assertion DO block referencing every table", () => {
    for (const t of TABLES) {
      expect(upSql).toMatch(new RegExp(t));
    }
    expect(upSql).toMatch(/aborting migration 083/);
  });

  it("down-migration drops every table with IF EXISTS in reverse FK order", () => {
    for (const t of TABLES) {
      expect(downSql).toMatch(new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${t}`));
    }
    // exceptions must drop before artifacts; attachments before messages;
    // messages before artifacts + feeds.
    const idx = (s: string) => downSql.indexOf(s);
    expect(idx("instinct_meeting_exceptions")).toBeLessThan(
      idx("instinct_meeting_artifacts"),
    );
    expect(idx("instinct_meeting_attachments")).toBeLessThan(
      idx("instinct_meeting_messages"),
    );
    expect(idx("instinct_meeting_messages")).toBeLessThan(
      idx("instinct_meeting_feeds"),
    );
    expect(idx("instinct_meeting_messages")).toBeLessThan(
      idx("instinct_meeting_artifacts"),
    );
  });

  it("down-migration wraps in BEGIN/COMMIT", () => {
    expect(downSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });
});
