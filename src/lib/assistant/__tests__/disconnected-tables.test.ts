/**
 * The table names this reader queries must actually exist.
 *
 * A wrong name does not fail loudly here. The query throws, the catch turns it
 * into null, null means "we could not tell", and the integration is never
 * flagged. The check goes on passing while doing nothing at all.
 *
 * That happened on the first attempt at this file: `instinct_qb_tokens` for a
 * table called `instinct_qbo_tokens`. The chip it was written to remove kept
 * being offered, and every test still passed. Same shape as the six controls
 * this codebase spent a week finding, written into the module built to stop
 * them.
 *
 * Checked against the migrations rather than a live database, so it runs in
 * the ordinary suite with no connection.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_TABLES } from "@/lib/assistant/disconnected-integrations";

const MIGRATIONS = join(process.cwd(), "src", "db", "migrations");

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n")
    .toLowerCase();
}

describe("connection lookup tables", () => {
  const sql = allMigrationSql();

  it.each(CONNECTION_TABLES)("%s is created by a migration", (table) => {
    expect(sql).toContain(table.toLowerCase());
  });

  it("found migrations to check, so an empty scan cannot pass", () => {
    /* Without this, a wrong directory would make every assertion above vacuous
       in the same way the typo made the reader vacuous. */
    expect(sql.length).toBeGreaterThan(1000);
    expect(sql).toContain("create table");
  });
});
