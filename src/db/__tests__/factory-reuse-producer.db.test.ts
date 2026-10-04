/**
 * Proves the factory-brain WRITE PATH actually LANDS data in Postgres - not that
 * the DB merely connects. The operator has been burned by writes that silently
 * dropped, so this exercises the REAL producer transform (repoTreeToDocs) + the
 * store's EXACT upsert / mark-embedded SQL against a real DB built from the real
 * migration 276, and reads every result back through an independent pg client.
 *
 * It uses a raw pg.Client (not the app pool) because the pool forces
 * sslmode=verify-full, which the CI's local Postgres does not support - the same
 * reason every other *.db.test.ts here uses a raw client.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { repoTreeToDocs } from "@/lib/ai-code/factory-reuse-producer";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "276_factory_reuse_corpus.sql");

// Verbatim from factory-reuse-store.ts (single-row form of its multi-row upsert).
const UPSERT = `INSERT INTO instinct_factory_reuse_corpus
     (workspace_id, repo, path, text, commit_sha, embedded, updated_at)
   VALUES ($1, $2, $3, $4, $5, false, now())
   ON CONFLICT (workspace_id, repo, path) DO UPDATE
     SET text = EXCLUDED.text, commit_sha = EXCLUDED.commit_sha, embedded = false, updated_at = now()`;
const MARK = `UPDATE instinct_factory_reuse_corpus SET embedded = true
   WHERE workspace_id = $1 AND repo = $2 AND path = ANY($3::text[])`;
const READ = `SELECT path, text, embedded FROM instinct_factory_reuse_corpus
   WHERE workspace_id = $1 AND repo = $2 ORDER BY path`;

describeIfDb("factory brain write path LANDS data (migration 276)", () => {
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

  // The REAL producer transform decides what gets persisted.
  const writeDocs = async (ws: string, repo: string, tree: string[]) => {
    const docs = repoTreeToDocs(tree);
    for (const d of docs) await db.query(UPSERT, [ws, repo, d.path, d.text, "sha1"]);
    return docs;
  };

  it("persists only the producer's source-file docs, readable back, embedded=false", async () => {
    const docs = await writeDocs("w1", "o/r", [
      "src/lib/cost-summary.ts",
      "src/lib/__tests__/x.test.ts", // test -> filtered by the producer
      "README.md", // not code -> filtered
    ]);
    expect(docs.map((d) => d.path)).toEqual(["src/lib/cost-summary.ts"]);
    const back = await db.query(READ, ["w1", "o/r"]);
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0].path).toBe("src/lib/cost-summary.ts");
    expect(back.rows[0].text).toBe("src lib cost summary"); // humanized by the producer
    expect(back.rows[0].embedded).toBe(false);
  });

  it("lifecycle: write -> mark embedded -> independent read confirms the transition", async () => {
    await writeDocs("w1", "o/r", ["src/a.ts", "src/b.ts"]);
    await db.query(MARK, ["w1", "o/r", ["src/a.ts"]]);
    const after = await db.query(READ, ["w1", "o/r"]);
    expect(after.rows).toEqual([
      { path: "src/a.ts", text: "src a", embedded: true },
      { path: "src/b.ts", text: "src b", embedded: false },
    ]);
  });

  it("re-writing upserts (no duplicate row) and resets embedded for re-index", async () => {
    await writeDocs("w1", "o/r", ["src/a.ts"]);
    await db.query(MARK, ["w1", "o/r", ["src/a.ts"]]);
    await writeDocs("w1", "o/r", ["src/a.ts"]); // producer runs again
    const rows = await db.query(
      `SELECT count(*)::int AS n, bool_or(embedded) AS any_embedded FROM instinct_factory_reuse_corpus WHERE workspace_id=$1`,
      ["w1"],
    );
    expect(rows.rows[0].n).toBe(1); // upsert, not duplicate
    expect(rows.rows[0].any_embedded).toBe(false); // changed row must be re-indexed
  });

  it("is workspace-isolated", async () => {
    await writeDocs("w1", "o/r", ["src/a.ts"]);
    await writeDocs("w2", "o/r", ["src/b.ts"]);
    expect((await db.query(READ, ["w1", "o/r"])).rows.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect((await db.query(READ, ["w2", "o/r"])).rows.map((r) => r.path)).toEqual(["src/b.ts"]);
  });
});
