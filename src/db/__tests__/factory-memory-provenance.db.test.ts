/**
 * Memory provenance (migration 279) lands + reads back against real Postgres.
 * Raw pg client (the app pool forces sslmode=verify-full). Proves: provenance
 * rows persist keyed by approval_id, re-recording is idempotent (ON CONFLICT DO
 * NOTHING), and the read is workspace+approval scoped.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "279_factory_memory_provenance.sql");

// Verbatim from recordMemoryProvenance / loadProvenanceByApproval.
const INS = `INSERT INTO instinct_factory_memory_provenance (workspace_id, approval_id, repo, kind, mem_key)
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (workspace_id, approval_id, kind, mem_key) DO NOTHING`;
const READ = `SELECT kind, mem_key FROM instinct_factory_memory_provenance
   WHERE workspace_id = $1 AND approval_id = $2 ORDER BY kind, mem_key`;

describeIfDb("factory memory provenance (migration 279)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_memory_provenance`);
    await db.query(readFileSync(MIGRATION, "utf8"));
    await db.query(readFileSync(MIGRATION, "utf8")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_memory_provenance`); });

  it("persists provenance keyed by approval_id, readable back", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "src/a.ts"]);
    await db.query(INS, ["w1", "appr1", "o/r", "failure", "sig1"]);
    const r = await db.query(READ, ["w1", "appr1"]);
    expect(r.rows).toEqual([{ kind: "failure", mem_key: "sig1" }, { kind: "reuse", mem_key: "src/a.ts" }]);
  });

  it("re-recording the same entry is idempotent (ON CONFLICT DO NOTHING)", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "src/a.ts"]);
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "src/a.ts"]); // again
    expect((await db.query(READ, ["w1", "appr1"])).rows).toHaveLength(1);
  });

  it("is workspace+approval scoped", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "a"]);
    await db.query(INS, ["w2", "appr1", "o/r", "reuse", "b"]);
    await db.query(INS, ["w1", "appr2", "o/r", "reuse", "c"]);
    expect((await db.query(READ, ["w1", "appr1"])).rows).toEqual([{ kind: "reuse", mem_key: "a" }]);
  });
});
