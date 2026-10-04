/**
 * Proves the factory-brain WRITE PATH actually LANDS data in Postgres - not that
 * the DB merely connects. The operator has been burned by writes that silently
 * dropped, so this drives the REAL store functions (rememberRepoTree ->
 * rememberReuseCorpus, loadUnembeddedCorpus, markCorpusEmbedded, countReuseCorpus)
 * against a real DB built from the real migration 276, and reads every result
 * back through an INDEPENDENT pg client (never trusting the same code that wrote).
 *
 * The store reads DATABASE_URL at import, so we point it at TEST_DATABASE_URL and
 * import the store dynamically (after the migration) inside beforeAll.
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

type Store = typeof import("@/lib/ai-code/factory-reuse-store");
type Producer = typeof import("@/lib/ai-code/factory-reuse-producer");

describeIfDb("factory brain write path LANDS data (migration 276, real functions)", () => {
  let db: Client;
  let store: Store;
  let producer: Producer;

  beforeAll(async () => {
    const conn = requireLocalTestDatabase(URL);
    // Point the store's pool at the test DB, THEN import it (pool binds at import).
    process.env.DATABASE_URL = conn;
    db = new Client({ connectionString: conn });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_reuse_corpus`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    store = await import("@/lib/ai-code/factory-reuse-store");
    producer = await import("@/lib/ai-code/factory-reuse-producer");
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_reuse_corpus`); });

  it("rememberRepoTree writes rows that are READABLE BACK by an independent client", async () => {
    const res = await producer.rememberRepoTree({
      workspaceId: "w1", repo: "o/r", commitSha: "sha1",
      treePaths: ["src/lib/cost-summary.ts", "src/lib/__tests__/x.test.ts", "README.md"],
    });
    expect(res.written).toBe(1); // only the source file

    // Independent read-back: the row is really in the table, with humanized text.
    const back = await db.query(
      `SELECT path, text, embedded FROM instinct_factory_reuse_corpus WHERE workspace_id=$1 AND repo=$2`,
      ["w1", "o/r"],
    );
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0].path).toBe("src/lib/cost-summary.ts");
    expect(back.rows[0].text).toBe("src lib cost summary");
    expect(back.rows[0].embedded).toBe(false); // needs a vector
  });

  it("the full lifecycle lands + transitions: write -> load-unembedded -> mark -> count", async () => {
    await producer.rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["src/a.ts", "src/b.ts"] });

    const unembedded = await store.loadUnembeddedCorpus("w1", "o/r", 100);
    expect(unembedded.map((r) => r.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);

    await store.markCorpusEmbedded("w1", "o/r", ["src/a.ts"]);

    // Independent client confirms exactly one row flipped embedded=true.
    const after = await db.query(
      `SELECT path, embedded FROM instinct_factory_reuse_corpus WHERE workspace_id=$1 AND repo=$2 ORDER BY path`,
      ["w1", "o/r"],
    );
    expect(after.rows).toEqual([
      { path: "src/a.ts", embedded: true },
      { path: "src/b.ts", embedded: false },
    ]);
    // Still-unembedded read now returns only b.
    expect((await store.loadUnembeddedCorpus("w1", "o/r", 100)).map((r) => r.path)).toEqual(["src/b.ts"]);
    expect(await store.countReuseCorpus("w1", "o/r")).toBe(2);
  });

  it("re-running the producer upserts (no duplicate rows) and resets embedded for re-index", async () => {
    await producer.rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["src/a.ts"] });
    await store.markCorpusEmbedded("w1", "o/r", ["src/a.ts"]);
    await producer.rememberRepoTree({ workspaceId: "w1", repo: "o/r", treePaths: ["src/a.ts"] }); // again

    const rows = await db.query(
      `SELECT count(*)::int AS n, bool_or(embedded) AS any_embedded FROM instinct_factory_reuse_corpus WHERE workspace_id=$1`,
      ["w1"],
    );
    expect(rows.rows[0].n).toBe(1); // upsert, not duplicate
    expect(rows.rows[0].any_embedded).toBe(false); // re-written row must be re-indexed
  });
});
