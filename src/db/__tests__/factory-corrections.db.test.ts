/**
 * #3 correction memory (migration 283) lands + folds back against real Postgres.
 * Raw pg client (the app pool forces sslmode=verify-full). Proves: a correction
 * row persists WITH its text[] categories (the write lands - dropped-write trap),
 * the per-task-type edit-rate + category-rate fold is correct, ON CONFLICT is
 * idempotent, and the read is workspace + task scoped.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "283_factory_corrections.sql");

const INS = `INSERT INTO instinct_factory_corrections
     (workspace_id, approval_id, repo, task_type, edited, categories, human_added, human_removed)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT (workspace_id, approval_id) DO NOTHING`;
const READ = `SELECT edited, categories FROM instinct_factory_corrections
   WHERE workspace_id = $1 AND task_type = $2
   ORDER BY approval_id`;

describeIfDb("factory corrections (migration 283)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_corrections`);
    await db.query(readFileSync(MIGRATION, "utf8"));
    await db.query(readFileSync(MIGRATION, "utf8")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_corrections`); });

  it("persists a correction WITH text[] categories, readable back (write lands)", async () => {
    await db.query(INS, ["w1", "a1", "o/r", "migration", true, ["tests", "types"], 5, 1]);
    const r = await db.query(READ, ["w1", "migration"]);
    expect(r.rows).toEqual([{ edited: true, categories: ["tests", "types"] }]);
  });

  it("re-recording the same approval is idempotent", async () => {
    await db.query(INS, ["w1", "a1", "o/r", "ui", true, ["tests"], 1, 0]);
    await db.query(INS, ["w1", "a1", "o/r", "ui", false, [], 0, 0]); // ignored
    const r = await db.query(READ, ["w1", "ui"]);
    expect(r.rows).toEqual([{ edited: true, categories: ["tests"] }]);
  });

  it("the edit-rate + category fold matches across rows (SQL-side sanity)", async () => {
    await db.query(INS, ["w1", "a1", "o/r", "api", true, ["tests", "error-handling"], 2, 0]);
    await db.query(INS, ["w1", "a2", "o/r", "api", true, ["tests"], 1, 0]);
    await db.query(INS, ["w1", "a3", "o/r", "api", false, [], 0, 0]);
    const agg = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE edited)::int AS edited,
              count(*) FILTER (WHERE edited AND 'tests' = ANY(categories))::int AS tests
         FROM instinct_factory_corrections WHERE workspace_id = $1 AND task_type = $2`,
      ["w1", "api"],
    );
    expect(agg.rows[0]).toEqual({ total: 3, edited: 2, tests: 2 });
  });

  it("is workspace + task scoped", async () => {
    await db.query(INS, ["w1", "a1", "o/r", "ui", true, ["tests"], 1, 0]);
    await db.query(INS, ["w2", "a1", "o/r", "ui", true, ["imports"], 1, 0]);
    await db.query(INS, ["w1", "a2", "o/r", "api", true, ["types"], 1, 0]);
    expect((await db.query(READ, ["w1", "ui"])).rows).toEqual([{ edited: true, categories: ["tests"] }]);
  });
});
