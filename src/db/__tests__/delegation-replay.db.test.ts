/**
 * Delegation replay store (migration 264): the jti PK makes an insert the atomic
 * replay check - a duplicate jti conflicts and touches zero rows. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "264_delegation_replay.sql");
const CONSUME = `INSERT INTO instinct_delegation_replay (jti, workspace_id, expires_at)
     VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (jti) DO NOTHING RETURNING jti`;

describeIfDb("delegation replay store (migration 264)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql); await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_delegation_replay"); });

  it("accepts a jti once and reports the duplicate as a replay (zero rows)", async () => {
    const first = await db.query(CONSUME, ["jti-1", "w1", 1_800_000_000]);
    const second = await db.query(CONSUME, ["jti-1", "w1", 1_800_000_000]);
    expect(first.rowCount).toBe(1);   // fresh
    expect(second.rowCount).toBe(0);  // replay
  });
});
