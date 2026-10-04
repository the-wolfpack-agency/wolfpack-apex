/**
 * #7 memory usefulness (migration 280) lands + reads back against real Postgres.
 * Raw pg client (the app pool forces sslmode=verify-full). Proves: the `used`
 * column persists per row and a WRITE is actually readable back (the write-drop
 * trap - a connection-only test would miss a dropped write), that 280 is
 * idempotent, and that it defaults to false for rows written before the column.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIG_279 = join(__dirname, "..", "migrations", "279_factory_memory_provenance.sql");
const MIG_280 = join(__dirname, "..", "migrations", "280_factory_provenance_used.sql");

// Verbatim from recordMemoryProvenance / loadProvenanceByApproval (with `used`).
const INS = `INSERT INTO instinct_factory_memory_provenance (workspace_id, approval_id, repo, kind, mem_key, used)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (workspace_id, approval_id, kind, mem_key) DO NOTHING`;
const READ = `SELECT kind, mem_key, used FROM instinct_factory_memory_provenance
   WHERE workspace_id = $1 AND approval_id = $2 ORDER BY kind, mem_key`;

describeIfDb("factory provenance `used` (migration 280)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_memory_provenance`);
    await db.query(readFileSync(MIG_279, "utf8"));
    await db.query(readFileSync(MIG_280, "utf8"));
    await db.query(readFileSync(MIG_280, "utf8")); // idempotent (ADD COLUMN IF NOT EXISTS)
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_memory_provenance`); });

  it("persists `used` per row and reads the WRITE back (no dropped write)", async () => {
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "src/used.ts", true]);
    await db.query(INS, ["w1", "appr1", "o/r", "reuse", "src/ignored.ts", false]);
    await db.query(INS, ["w1", "appr1", "o/r", "failure", "sig1", false]);
    const r = await db.query(READ, ["w1", "appr1"]);
    expect(r.rows).toEqual([
      { kind: "failure", mem_key: "sig1", used: false },
      { kind: "reuse", mem_key: "src/ignored.ts", used: false },
      { kind: "reuse", mem_key: "src/used.ts", used: true },
    ]);
  });

  it("defaults `used` to false for a row written without it (back-compat)", async () => {
    await db.query(
      `INSERT INTO instinct_factory_memory_provenance (workspace_id, approval_id, repo, kind, mem_key)
         VALUES ('w1', 'appr2', 'o/r', 'reuse', 'src/legacy.ts')`,
    );
    const r = await db.query(READ, ["w1", "appr2"]);
    expect(r.rows).toEqual([{ kind: "reuse", mem_key: "src/legacy.ts", used: false }]);
  });
});
