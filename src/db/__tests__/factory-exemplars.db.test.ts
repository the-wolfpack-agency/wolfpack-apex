/**
 * #10 exemplars (migration 281) land + read back against real Postgres. Raw pg
 * client (the app pool forces sslmode=verify-full). Proves: a recorded exemplar
 * is PENDING (not returned by the merged-only read), markExemplarMerged flips it
 * and then it IS returned (the write actually lands - the dropped-write trap),
 * the flip is idempotent, and the read is workspace + task scoped.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "281_factory_exemplars.sql");

// Verbatim from the store.
const INS = `INSERT INTO instinct_factory_exemplars (workspace_id, approval_id, repo, task_type, prompt, model)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (workspace_id, approval_id) DO NOTHING`;
const MARK = `UPDATE instinct_factory_exemplars
      SET merged = true, merged_at = now()
    WHERE workspace_id = $1 AND approval_id = $2 AND merged = false`;
const READ = `SELECT repo, task_type, prompt, model
   FROM instinct_factory_exemplars
  WHERE workspace_id = $1 AND task_type = $2 AND merged = true
  ORDER BY created_at DESC LIMIT 3`;

describeIfDb("factory exemplars (migration 281)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_exemplars`);
    await db.query(readFileSync(MIGRATION, "utf8"));
    await db.query(readFileSync(MIGRATION, "utf8")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_exemplars`); });

  it("pending until merged, then readable back (the write actually lands)", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "migration", "Add a quotas table", "gpt-4o-mini"]);
    // pending -> the merged-only read returns nothing
    expect((await db.query(READ, ["w1", "migration"])).rows).toEqual([]);
    // promote, then it IS returned
    const upd = await db.query(MARK, ["w1", "appr1"]);
    expect(upd.rowCount).toBe(1);
    expect((await db.query(READ, ["w1", "migration"])).rows).toEqual([
      { repo: "o/r", task_type: "migration", prompt: "Add a quotas table", model: "gpt-4o-mini" },
    ]);
  });

  it("the merge flip is idempotent (second mark changes nothing)", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "ui", "p", "m"]);
    expect((await db.query(MARK, ["w1", "appr1"])).rowCount).toBe(1);
    expect((await db.query(MARK, ["w1", "appr1"])).rowCount).toBe(0); // AND merged = false
  });

  it("re-recording the same approval is idempotent (ON CONFLICT DO NOTHING)", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "ui", "first", "m"]);
    await db.query(INS, ["w1", "appr1", "o/r", "ui", "second", "m"]); // ignored
    await db.query(MARK, ["w1", "appr1"]);
    const r = await db.query(READ, ["w1", "ui"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].prompt).toBe("first");
  });

  it("is workspace + task scoped", async () => {
    await db.query(INS, ["w1", "a1", "o/r", "api", "keep", "m"]);
    await db.query(INS, ["w2", "a1", "o/r", "api", "other-ws", "m"]);
    await db.query(INS, ["w1", "a2", "o/r", "ui", "other-task", "m"]);
    for (const a of ["a1", "a2"]) await db.query(MARK, ["w1", a]);
    await db.query(MARK, ["w2", "a1"]);
    const r = await db.query(READ, ["w1", "api"]);
    expect(r.rows).toEqual([{ repo: "o/r", task_type: "api", prompt: "keep", model: "m" }]);
  });
});
