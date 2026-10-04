/**
 * Reuse corpus store (factory brain part 1) against a REAL Postgres built from
 * the REAL migration 276. Proves the upsert SQL runs against the produced schema,
 * that (workspace, repo, path) upsert is idempotent and resets embedded=false,
 * and that the read is workspace-isolated - the predicate that IS the tenant
 * boundary for this table.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "276_factory_reuse_corpus.sql");

const UPSERT = `INSERT INTO instinct_factory_reuse_corpus
     (workspace_id, repo, path, text, commit_sha, embedded, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, now())
   ON CONFLICT (workspace_id, repo, path) DO UPDATE
     SET text = EXCLUDED.text, commit_sha = EXCLUDED.commit_sha, embedded = false, updated_at = now()`;
const READ = `SELECT path, text, commit_sha, embedded FROM instinct_factory_reuse_corpus
   WHERE workspace_id = $1 AND repo = $2 ORDER BY path`;

describeIfDb("factory reuse corpus (migration 276)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_reuse_corpus`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_reuse_corpus`); });

  it("persists and reads back a corpus row", async () => {
    await db.query(UPSERT, ["w1", "o/r", "src/a.ts", "a words", "sha1", false]);
    const r = await db.query(READ, ["w1", "o/r"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].path).toBe("src/a.ts");
    expect(r.rows[0].text).toBe("a words");
  });

  it("upsert on (workspace, repo, path) updates text + resets embedded to false", async () => {
    await db.query(UPSERT, ["w1", "o/r", "src/a.ts", "old", "sha1", true]);
    await db.query(UPSERT, ["w1", "o/r", "src/a.ts", "new", "sha2", true]);
    const r = await db.query(READ, ["w1", "o/r"]);
    expect(r.rows).toHaveLength(1); // no duplicate row
    expect(r.rows[0].text).toBe("new");
    expect(r.rows[0].commit_sha).toBe("sha2");
    expect(r.rows[0].embedded).toBe(false); // a changed row needs re-embedding
  });

  it("is workspace-isolated: w2 never sees w1's corpus", async () => {
    await db.query(UPSERT, ["w1", "o/r", "src/a.ts", "a", "s", false]);
    await db.query(UPSERT, ["w2", "o/r", "src/b.ts", "b", "s", false]);
    const r1 = await db.query(READ, ["w1", "o/r"]);
    const r2 = await db.query(READ, ["w2", "o/r"]);
    expect(r1.rows.map((x) => x.path)).toEqual(["src/a.ts"]);
    expect(r2.rows.map((x) => x.path)).toEqual(["src/b.ts"]);
  });
});
