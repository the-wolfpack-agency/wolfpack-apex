/**
 * BYO model-key storage, run against a REAL Postgres built from the REAL
 * migration 250. Unit tests mock `query`, so they prove we send the text we
 * meant to; this proves the text runs against the schema the migration produces
 * - the class of bug (a column that does not exist, a constraint that does not
 * fire) that only a real database catches.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

// The store's SQL, verbatim (src/lib/ai/model-keys.ts).
const UPSERT = `
  INSERT INTO instinct_workspace_model_keys
    (workspace_id, provider, label, encrypted_key, key_hint, created_by, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, now())
  ON CONFLICT (workspace_id, provider)
    DO UPDATE SET label = EXCLUDED.label, encrypted_key = EXCLUDED.encrypted_key,
                  key_hint = EXCLUDED.key_hint, created_by = EXCLUDED.created_by, updated_at = now()
  RETURNING id, created_at::text AS created_at`;
const LIST = `
  SELECT id, provider, label, key_hint, created_at::text AS created_at
    FROM instinct_workspace_model_keys WHERE workspace_id = $1 ORDER BY provider`;
const DECRYPT = `
  SELECT encrypted_key FROM instinct_workspace_model_keys WHERE workspace_id = $1 AND provider = $2`;

describeIfDb("BYO model-key storage", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_workspace_model_keys CASCADE`);
    // Apply the ACTUAL migration file, not a reproduction.
    await db.query(readFileSync(join(__dirname, "..", "migrations", "250_workspace_model_keys.sql"), "utf8"));
  });

  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_workspace_model_keys`); });

  it("upserts and reads back the row against the migration's schema", async () => {
    const ins = await db.query(UPSERT, ["w1", "openai", "prod", "v1.enc-token", "****1234", "u1"]);
    expect(ins.rows).toHaveLength(1);
    const list = await db.query(LIST, ["w1"]);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].key_hint).toBe("****1234");
    // The list SQL never selects encrypted_key.
    expect(Object.keys(list.rows[0])).not.toContain("encrypted_key");
    const dec = await db.query(DECRYPT, ["w1", "openai"]);
    expect(dec.rows[0].encrypted_key).toBe("v1.enc-token");
  });

  it("is workspace-isolated: another workspace reads nothing", async () => {
    await db.query(UPSERT, ["w1", "openai", null, "v1.enc", "****9999", "u1"]);
    expect((await db.query(LIST, ["w2"])).rows).toHaveLength(0);
    expect((await db.query(DECRYPT, ["w2", "openai"])).rows).toHaveLength(0);
  });

  it("rotates in place: the same (workspace, provider) stays one row", async () => {
    await db.query(UPSERT, ["w1", "anthropic", null, "v1.old", "****1111", "u1"]);
    await db.query(UPSERT, ["w1", "anthropic", null, "v1.new", "****2222", "u1"]);
    const list = await db.query(LIST, ["w1"]);
    expect(list.rows).toHaveLength(1);
    expect((await db.query(DECRYPT, ["w1", "anthropic"])).rows[0].encrypted_key).toBe("v1.new");
  });

  it("the CHECK constraint rejects an unknown provider", async () => {
    await expect(
      db.query(UPSERT, ["w1", "hackerllm", null, "v1.x", "****0000", "u1"]),
    ).rejects.toThrow(/instinct_workspace_model_keys_provider_chk|check constraint/i);
  });
});
