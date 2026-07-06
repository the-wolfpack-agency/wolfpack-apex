/**
 * Shape guard for 217_deactivate_seed_team_members.sql (offline; no DB).
 *
 * Asserts the migration deactivates ONLY undeliverable seed rows, is idempotent
 * (touches only still-active rows), is non-destructive, and ships a paired
 * .down.sql per the migration convention.
 */

import fs from "node:fs";
import path from "node:path";

const UP = path.resolve(__dirname, "..", "217_deactivate_seed_team_members.sql");
const DOWN = path.resolve(
  __dirname,
  "..",
  "217_deactivate_seed_team_members.down.sql",
);

describe("217_deactivate_seed_team_members.sql", () => {
  const sql = fs.readFileSync(UP, "utf-8");
  // Executable SQL only — strip `--` line comments so prose that names DDL
  // keywords (e.g. "no DROP / DELETE") doesn't false-positive the guards below.
  const executable = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  test("deactivates instinct_team_members rows on the seed domain", () => {
    expect(sql).toMatch(/UPDATE\s+instinct_team_members/i);
    expect(sql).toMatch(/SET\s+is_active\s*=\s*false/i);
    expect(sql).toMatch(/lower\(email\)\s+LIKE\s+'%@wolfpack\.dev'/i);
  });

  test("idempotent — only touches rows that are still active", () => {
    expect(sql).toMatch(/WHERE\s+is_active\s*=\s*true/i);
  });

  test("is non-destructive (no DROP / DELETE / TRUNCATE)", () => {
    expect(executable).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });

  test("does not touch the real agency domain", () => {
    expect(sql).not.toMatch(/thewolfpack\.agency/i);
  });

  test("ships a paired .down.sql", () => {
    expect(fs.existsSync(DOWN)).toBe(true);
    expect(fs.readFileSync(DOWN, "utf-8").trim().length).toBeGreaterThan(0);
  });
});
