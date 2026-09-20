/**
 * Edge-policy table against a REAL Postgres from migration 262: idempotent,
 * per-workspace upsert of the mode, and the mode CHECK. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "262_edge_policy.sql");
const UPSERT = `INSERT INTO instinct_edge_policy (workspace_id, mode, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`;

describeIfDb("edge policy (migration 262)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_edge_policy"); });

  it("upserts the mode per workspace in place", async () => {
    await db.query(UPSERT, ["w1", "enforce", "u1"]);
    await db.query(UPSERT, ["w1", "monitor", "u1"]);
    const r = await db.query("SELECT count(*)::int AS n, mode FROM instinct_edge_policy WHERE workspace_id='w1' GROUP BY mode");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ n: 1, mode: "monitor" });
  });

  it("rejects an out-of-vocabulary mode via CHECK", async () => {
    await expect(db.query(UPSERT, ["w1", "yolo", "u1"])).rejects.toThrow();
  });
});
