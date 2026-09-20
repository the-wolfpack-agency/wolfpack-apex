/** External audit anchors (migration 267): idempotent, records a head, supports
 *  the tamper-verify read. Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "267_audit_external_anchors.sql");

describeIfDb("audit external anchors (migration 267)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql); await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_audit_external_anchors"); });

  it("records a published head and reads it back by seq", async () => {
    await db.query("INSERT INTO instinct_audit_external_anchors (seq, entry_hash, target) VALUES (42, 'hABC', 'https://witness')");
    const r = await db.query("SELECT seq, entry_hash FROM instinct_audit_external_anchors WHERE seq = 42");
    expect(r.rows[0]).toEqual({ seq: "42", entry_hash: "hABC" });
  });
});
