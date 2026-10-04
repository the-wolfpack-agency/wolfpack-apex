/**
 * Memory confidence (migration 278) lands + reads back against real Postgres.
 * Raw pg client (the app pool forces sslmode=verify-full, unsupported by CI's
 * local PG). Proves: the column is added with default 1.0 on BOTH memory tables,
 * the loader SQL reads it workspace+repo+key scoped, and an UPDATE (the future
 * reinforcement path) persists a changed confidence.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const mig = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");

// Verbatim from the store loaders.
const READ_REUSE = `SELECT path, confidence FROM instinct_factory_reuse_corpus
   WHERE workspace_id = $1 AND repo = $2 AND path = ANY($3::text[])`;
const READ_FAIL = `SELECT signature, confidence FROM instinct_factory_failure_memory
   WHERE workspace_id = $1 AND repo = $2 AND signature = ANY($3::text[])`;

describeIfDb("factory memory confidence (migration 278)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_reuse_corpus`);
    await db.query(`DROP TABLE IF EXISTS instinct_factory_failure_memory`);
    await db.query(mig("276_factory_reuse_corpus.sql"));
    await db.query(mig("277_factory_failure_memory.sql"));
    await db.query(mig("278_factory_memory_confidence.sql"));
    await db.query(mig("278_factory_memory_confidence.sql")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query(`TRUNCATE instinct_factory_reuse_corpus`);
    await db.query(`TRUNCATE instinct_factory_failure_memory`);
  });

  it("reuse corpus: confidence defaults to 1.0 and the loader reads it", async () => {
    await db.query(
      `INSERT INTO instinct_factory_reuse_corpus (workspace_id, repo, path, text) VALUES ('w1','o/r','src/a.ts','a')`,
    );
    const r = await db.query(READ_REUSE, ["w1", "o/r", ["src/a.ts"]]);
    expect(Number(r.rows[0].confidence)).toBe(1);
  });

  it("failure memory: confidence defaults to 1.0; an UPDATE (reinforcement) persists", async () => {
    await db.query(
      `INSERT INTO instinct_factory_failure_memory (workspace_id, repo, signature, finding_class, summary) VALUES ('w1','o/r','sig1','c','s')`,
    );
    expect(Number((await db.query(READ_FAIL, ["w1", "o/r", ["sig1"]])).rows[0].confidence)).toBe(1);
    // the future reinforce/decay path: move confidence, read it back.
    await db.query(`UPDATE instinct_factory_failure_memory SET confidence = 1.75 WHERE signature = 'sig1'`);
    expect(Number((await db.query(READ_FAIL, ["w1", "o/r", ["sig1"]])).rows[0].confidence)).toBeCloseTo(1.75, 5);
  });

  it("loader is workspace-isolated", async () => {
    await db.query(`INSERT INTO instinct_factory_reuse_corpus (workspace_id, repo, path, text, confidence) VALUES ('w1','o/r','p','t',0.5)`);
    await db.query(`INSERT INTO instinct_factory_reuse_corpus (workspace_id, repo, path, text, confidence) VALUES ('w2','o/r','p','t',0.9)`);
    expect(Number((await db.query(READ_REUSE, ["w1", "o/r", ["p"]])).rows[0].confidence)).toBe(0.5);
    expect(Number((await db.query(READ_REUSE, ["w2", "o/r", ["p"]])).rows[0].confidence)).toBeCloseTo(0.9, 5);
  });
});
