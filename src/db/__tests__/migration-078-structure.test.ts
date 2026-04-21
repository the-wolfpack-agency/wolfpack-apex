/**
 * Structural invariants for migration 078_entity_tags_and_links.
 *
 * L3 polymorphic layer (tags + links) sits above L1 (instinct_ms_*). This
 * test protects the schema shape + paired .down.sql.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const UP_PATH = join(MIGRATIONS_DIR, "078_entity_tags_and_links.sql");
const DOWN_PATH = join(MIGRATIONS_DIR, "078_entity_tags_and_links.down.sql");

const upSql = readFileSync(UP_PATH, "utf8");

describe("migration 078 — instinct_entity_tags + instinct_entity_links", () => {
  it("creates instinct_entity_tags with required columns", () => {
    expect(upSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+instinct_entity_tags/i);
    for (const col of [
      "id",
      "entity_type",
      "entity_id",
      "tag_key",
      "tag_value",
      "auto_applied",
      "applied_by_user_id",
      "created_at",
    ]) {
      expect(upSql).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("uses UUID PK + gen_random_uuid default on tags", () => {
    expect(upSql).toMatch(/id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
  });

  it("indexes tags on (entity_type, entity_id)", () => {
    expect(upSql).toMatch(
      /CREATE\s+INDEX[\s\S]*?idx_instinct_entity_tags_entity[\s\S]*?\(entity_type,\s*entity_id\)/i,
    );
  });

  it("indexes tags on (tag_key, tag_value)", () => {
    expect(upSql).toMatch(
      /CREATE\s+INDEX[\s\S]*?idx_instinct_entity_tags_key_value[\s\S]*?\(tag_key,\s*tag_value\)/i,
    );
  });

  it("has composite unique dedup index on tags", () => {
    expect(upSql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?uq_instinct_entity_tags_dedup[\s\S]*?\(entity_type,\s*entity_id,\s*tag_key,\s*tag_value,\s*auto_applied\)/i,
    );
  });

  it("creates instinct_entity_links with required columns", () => {
    expect(upSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+instinct_entity_links/i);
    for (const col of [
      "from_entity_type",
      "from_entity_id",
      "to_entity_type",
      "to_entity_id",
      "link_type",
      "auto_applied",
      "applied_by_user_id",
      "created_at",
    ]) {
      expect(upSql).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("indexes links on from + to + link_type", () => {
    expect(upSql).toMatch(/idx_instinct_entity_links_from/);
    expect(upSql).toMatch(/idx_instinct_entity_links_to/);
    expect(upSql).toMatch(/idx_instinct_entity_links_type/);
  });

  it("has composite unique dedup index on links", () => {
    expect(upSql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?uq_instinct_entity_links_dedup/i,
    );
  });

  it("wraps DDL in BEGIN/COMMIT", () => {
    expect(upSql).toMatch(/\bBEGIN\b/);
    expect(upSql).toMatch(/\bCOMMIT\b/);
  });

  it("has a paired .down.sql file", () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
  });

  it("header documents the L3-above-L1 invariant", () => {
    const header = upSql.split("\n").slice(0, 30).join("\n");
    expect(header).toMatch(/L3/i);
    expect(header).toMatch(/L1/);
    expect(header).toMatch(/polymorphic/i);
  });

  describe(".down.sql", () => {
    const downSql = readFileSync(DOWN_PATH, "utf8");

    it("drops links table IF EXISTS", () => {
      expect(downSql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+instinct_entity_links/i);
    });

    it("drops tags table IF EXISTS", () => {
      expect(downSql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+instinct_entity_tags/i);
    });

    it("drops indexes before tables (idempotent order)", () => {
      const dropIdxLine = downSql.search(/DROP\s+INDEX\s+IF\s+EXISTS/i);
      const dropTblLine = downSql.search(/DROP\s+TABLE\s+IF\s+EXISTS/i);
      expect(dropIdxLine).toBeGreaterThanOrEqual(0);
      expect(dropTblLine).toBeGreaterThan(dropIdxLine);
    });

    it("wraps in BEGIN/COMMIT", () => {
      expect(downSql).toMatch(/\bBEGIN\b/);
      expect(downSql).toMatch(/\bCOMMIT\b/);
    });
  });
});
