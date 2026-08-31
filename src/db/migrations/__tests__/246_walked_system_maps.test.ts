/**
 * Shape guard for 246_walked_system_maps.sql (offline; no DB).
 *
 * The table exists because a walked map and a repo-read profile know
 * genuinely different things, and the columns encode that: what the walk did
 * NOT reach is denormalized alongside what it did, so a listing cannot show
 * counts without showing how complete they are.
 */
import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "246_walked_system_maps.sql");
const DOWN = path.resolve(__dirname, "..", "246_walked_system_maps.down.sql");

describe("246_walked_system_maps.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_walked_system_maps idempotently", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instinct_walked_system_maps/i);
  });

  test("is workspace scoped", () => {
    expect(sql).toMatch(/workspace_id\s+TEXT\s+NOT NULL/i);
  });

  test("stores the map as JSONB", () => {
    expect(sql).toMatch(/map\s+JSONB\s+NOT NULL/i);
  });

  /* THE COUNTS AND THEIR CAVEAT TRAVEL TOGETHER. A listing that showed
     nineteen screens without showing thirty-four still queued would describe a
     sample as an estate. */
  test("denormalizes what the walk did not reach, next to what it did", () => {
    expect(sql).toMatch(/surface_count\s+INTEGER\s+NOT NULL/i);
    expect(sql).toMatch(/entity_count\s+INTEGER\s+NOT NULL/i);
    expect(sql).toMatch(/form_count\s+INTEGER\s+NOT NULL/i);
    expect(sql).toMatch(/frontier_remaining\s+INTEGER\s+NOT NULL/i);
    expect(sql).toMatch(/stop_reason\s+TEXT/i);
  });

  /* Walking somebody else's system is a permitted act, and the record that it
     was permitted outlives the map. NOT NULL so it cannot be omitted. */
  test("requires who authorized the walk", () => {
    expect(sql).toMatch(/authorized_by\s+TEXT\s+NOT NULL/i);
  });

  /* One row per target: re-walking replaces the snapshot rather than
     accumulating stale ones a report might average over. */
  test("is unique per workspace and entry point", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS instinct_walked_system_maps_target[\s\S]*workspace_id, entry_url/i,
    );
  });

  test("indexes the workspace listing by recency", () => {
    expect(sql).toMatch(/workspace_id, generated_at DESC/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(/DROP TABLE IF EXISTS instinct_walked_system_maps/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS instinct_walked_system_maps_target/i);
  });
});
