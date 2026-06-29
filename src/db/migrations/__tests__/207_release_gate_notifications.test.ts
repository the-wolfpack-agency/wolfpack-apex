/**
 * Shape guard for 207_release_gate_notifications.sql (offline; no DB).
 *
 * Asserts the release-gate notification dedupe ledger is created with a TEXT
 * opaque id (schema-guard parity, never UUID), an INT pr_number, a last_state
 * column, a notified_at default-NOW timestamp, the pr_number + notified_at
 * indexes, RLS enabled with a permissive policy (the deny-by-default tripwire),
 * idempotency (IF NOT EXISTS guards), and a paired reversible .down.sql.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "207_release_gate_notifications.sql");
const DOWN = path.resolve(__dirname, "..", "207_release_gate_notifications.down.sql");

describe("207_release_gate_notifications.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");

  test("creates instinct_release_gate_notifications idempotently", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS instinct_release_gate_notifications/i,
    );
  });

  test("id is TEXT primary key (schema-guard parity, never UUID)", () => {
    expect(sql).toMatch(/\bid\s+TEXT\s+PRIMARY KEY/i);
    expect(sql).not.toMatch(/\bid\s+UUID/i);
  });

  test("has pr_number INT, last_state TEXT, notified_at default NOW", () => {
    expect(sql).toMatch(/pr_number\s+INT\s+NOT NULL/i);
    expect(sql).toMatch(/last_state\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/notified_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
  });

  test("indexes pr_number and notified_at for the cooldown read", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_release_gate_notifications_pr\s+ON instinct_release_gate_notifications \(pr_number\)/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_release_gate_notifications_notified_at\s+ON instinct_release_gate_notifications \(notified_at DESC\)/i,
    );
  });

  test("enables RLS with a permissive policy (deny-by-default tripwire)", () => {
    expect(sql).toMatch(
      /ALTER TABLE instinct_release_gate_notifications ENABLE ROW LEVEL SECURITY/i,
    );
    expect(sql).toMatch(
      /CREATE POLICY instinct_release_gate_notifications_all ON instinct_release_gate_notifications\s+FOR ALL USING \(true\) WITH CHECK \(true\)/i,
    );
  });

  test("guards the schema in a DO block (TEXT id, INT pr_number, RLS on)", () => {
    expect(sql).toMatch(/id must be TEXT/i);
    expect(sql).toMatch(/pr_number must be INT/i);
    expect(sql).toMatch(/RLS not enabled on instinct_release_gate_notifications/i);
  });

  test("has a paired reversible down migration", () => {
    const down = fs.readFileSync(DOWN, "utf-8");
    expect(down).toMatch(
      /DROP TABLE IF EXISTS instinct_release_gate_notifications/i,
    );
    expect(down).toMatch(
      /DROP INDEX IF EXISTS idx_release_gate_notifications_pr/i,
    );
    expect(down).toMatch(
      /DROP INDEX IF EXISTS idx_release_gate_notifications_notified_at/i,
    );
    expect(down).toMatch(
      /DROP POLICY IF EXISTS instinct_release_gate_notifications_all/i,
    );
  });
});
