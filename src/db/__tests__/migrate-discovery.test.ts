/**
 * Guards the migration runner against the footgun where `.down.sql`
 * rollback files were globbed as FORWARD migrations and executed on
 * deploy (every table's DROP ran as an apply; it only survived by
 * sort-order luck + IF EXISTS). Forward discovery must exclude downs.
 */
import fs from "node:fs";
import path from "node:path";

// activePool() is what the module actually calls; it closes over the
// module-internal pool, so the `pool` export alone is not enough.
jest.mock("@/lib/db", () => ({ pool: { connect: jest.fn() }, activePool: () => ({ connect: jest.fn() }) }));

import { isForwardMigration, discoverMigrations } from "@/db/migrate";

describe("migration discovery", () => {
  test("isForwardMigration: .sql yes, .down.sql no", () => {
    expect(isForwardMigration("161_surveys.sql")).toBe(true);
    expect(isForwardMigration("161_surveys.down.sql")).toBe(false);
    expect(isForwardMigration("notes.md")).toBe(false);
  });

  test("discoverMigrations never returns a .down.sql file", () => {
    const all = discoverMigrations();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((n) => n.endsWith(".down.sql"))).toBe(false);
    // And it IS finding real forward migrations.
    expect(all.some((n) => /^\d{3}_.*\.sql$/.test(n))).toBe(true);
  });

  test("the repo actually has down files (so the exclusion is meaningful)", () => {
    const dir = path.resolve(__dirname, "..", "migrations");
    const downs = fs.readdirSync(dir).filter((f) => f.endsWith(".down.sql"));
    expect(downs.length).toBeGreaterThan(0); // they exist, but must be excluded above
  });
});
