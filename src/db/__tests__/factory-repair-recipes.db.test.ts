/**
 * #8 repair recipes (migration 282) land + aggregate back against real Postgres.
 * Raw pg client (the app pool forces sslmode=verify-full). Proves: outcome rows
 * persist (the WRITE lands - dropped-write trap), the per-category resolve-rate
 * aggregation is correct, the window filter excludes old rows, and it is
 * workspace scoped.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "282_factory_repair_recipes.sql");

const INS = `INSERT INTO instinct_factory_repair_recipes (workspace_id, repo, blocked_by, attempts, resolved)
   VALUES ($1, $2, $3, $4, $5)`;
// Verbatim aggregation from loadRepairEfficacy.
const AGG = `SELECT blocked_by,
          count(*)::int AS runs,
          count(*) FILTER (WHERE resolved)::int AS resolved
     FROM instinct_factory_repair_recipes
    WHERE workspace_id = $1 AND created_at > now() - ($2 || ' days')::interval
    GROUP BY blocked_by
    ORDER BY blocked_by`;

describeIfDb("factory repair recipes (migration 282)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_repair_recipes`);
    await db.query(readFileSync(MIGRATION, "utf8"));
    await db.query(readFileSync(MIGRATION, "utf8")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_repair_recipes`); });

  it("persists outcomes and aggregates resolve-rate per category (write lands)", async () => {
    await db.query(INS, ["w1", "o/r", "security", 1, true]);
    await db.query(INS, ["w1", "o/r", "security", 2, false]);
    await db.query(INS, ["w1", "o/r", "invariant", 1, true]);
    const r = await db.query(AGG, ["w1", "30"]);
    expect(r.rows).toEqual([
      { blocked_by: "invariant", runs: 1, resolved: 1 },
      { blocked_by: "security", runs: 2, resolved: 1 },
    ]);
  });

  it("the window filter excludes rows older than N days", async () => {
    await db.query(
      `INSERT INTO instinct_factory_repair_recipes (workspace_id, repo, blocked_by, attempts, resolved, created_at)
         VALUES ('w1', 'o/r', 'deep-scan', 1, true, now() - interval '40 days')`,
    );
    expect((await db.query(AGG, ["w1", "30"])).rows).toEqual([]);
  });

  it("is workspace scoped", async () => {
    await db.query(INS, ["w1", "o/r", "security", 1, true]);
    await db.query(INS, ["w2", "o/r", "security", 1, true]);
    expect((await db.query(AGG, ["w1", "30"])).rows).toEqual([{ blocked_by: "security", runs: 1, resolved: 1 }]);
  });
});
