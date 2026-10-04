/**
 * Failure/pattern memory lands in Postgres (migration 277). Raw pg client (the
 * app pool forces sslmode=verify-full, unsupported by CI's local PG), write then
 * read back through an independent query. Proves: a confirmed failure persists, a
 * recurrence bumps times_seen (not a duplicate row) and resets embedded, and the
 * read is workspace-isolated.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "277_factory_failure_memory.sql");

// Verbatim from factory-failure-store.ts (single-row form of the multi-row upsert).
const UPSERT = `INSERT INTO instinct_factory_failure_memory
     (workspace_id, repo, signature, finding_class, summary, path, severity)
   VALUES ($1, $2, $3, $4, $5, $6, $7)
   ON CONFLICT (workspace_id, repo, signature) DO UPDATE
     SET times_seen = instinct_factory_failure_memory.times_seen + 1,
         path = EXCLUDED.path, severity = EXCLUDED.severity, embedded = false, updated_at = now()`;
const READ = `SELECT signature, finding_class, summary, times_seen, embedded
   FROM instinct_factory_failure_memory WHERE workspace_id = $1 AND repo = $2 ORDER BY finding_class`;

describeIfDb("factory failure memory LANDS data (migration 277)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_failure_memory`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_failure_memory`); });

  it("persists a confirmed failure, readable back, embedded=false, times_seen=1", async () => {
    await db.query(UPSERT, ["w1", "o/r", "sig1", "logged_credential", "secret written to a log", "src/x.ts", "critical"]);
    const back = await db.query(READ, ["w1", "o/r"]);
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0]).toMatchObject({ finding_class: "logged_credential", summary: "secret written to a log", times_seen: 1, embedded: false });
  });

  it("a recurrence bumps times_seen (no duplicate row) and resets embedded", async () => {
    await db.query(UPSERT, ["w1", "o/r", "sig1", "sql_injection", "string-built query", "src/q.ts", "high"]);
    await db.query(`UPDATE instinct_factory_failure_memory SET embedded = true WHERE signature = 'sig1'`);
    await db.query(UPSERT, ["w1", "o/r", "sig1", "sql_injection", "string-built query", "src/q.ts", "high"]); // again
    const back = await db.query(READ, ["w1", "o/r"]);
    expect(back.rows).toHaveLength(1); // upsert, not duplicate
    expect(back.rows[0].times_seen).toBe(2);
    expect(back.rows[0].embedded).toBe(false); // changed -> re-index
  });

  it("is workspace-isolated", async () => {
    await db.query(UPSERT, ["w1", "o/r", "s", "c", "a", "", "high"]);
    await db.query(UPSERT, ["w2", "o/r", "s", "c", "b", "", "high"]);
    expect((await db.query(READ, ["w1", "o/r"])).rows[0].summary).toBe("a");
    expect((await db.query(READ, ["w2", "o/r"])).rows[0].summary).toBe("b");
  });
});
