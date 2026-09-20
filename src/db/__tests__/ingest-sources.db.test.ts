/** Ingest-source registry (migration 266): upsert by source_id, EC JWK stored,
 *  algorithm CHECK. Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "266_ingest_sources.sql");

describeIfDb("ingest sources (migration 266)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql); await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_ingest_sources"); });

  it("upserts a source's public key by source_id", async () => {
    await db.query("INSERT INTO instinct_ingest_sources (source_id, public_key) VALUES ('mkt', '{\"kty\":\"EC\"}'::jsonb)");
    await db.query("INSERT INTO instinct_ingest_sources (source_id, public_key) VALUES ('mkt', '{\"kty\":\"EC\",\"x\":\"new\"}'::jsonb) ON CONFLICT (source_id) DO UPDATE SET public_key = EXCLUDED.public_key");
    const r = await db.query("SELECT count(*)::int AS n, public_key FROM instinct_ingest_sources WHERE source_id='mkt' GROUP BY public_key");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].public_key).toEqual({ kty: "EC", x: "new" });
  });

  it("rejects a non-es256 algorithm via CHECK", async () => {
    await expect(db.query("INSERT INTO instinct_ingest_sources (source_id, algorithm, public_key) VALUES ('x','rs256','{}'::jsonb)")).rejects.toThrow();
  });
});
