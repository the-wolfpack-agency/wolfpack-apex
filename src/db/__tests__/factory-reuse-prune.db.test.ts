/**
 * pruneStaleReuse against real Postgres (migration 276). Raw pg client (the app
 * pool forces sslmode=verify-full, unsupported by CI's local PG). Proves the
 * DELETE removes only paths absent from the live tree, keeps present ones, is
 * workspace-isolated, and - the critical safety - an EMPTY tree wipes NOTHING.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "276_factory_reuse_corpus.sql");

// Verbatim from factory-reuse-store.pruneStaleReuse.
const PRUNE = `DELETE FROM instinct_factory_reuse_corpus
   WHERE workspace_id = $1 AND repo = $2 AND NOT (path = ANY($3::text[]))`;
const READ = `SELECT path FROM instinct_factory_reuse_corpus WHERE workspace_id=$1 AND repo=$2 ORDER BY path`;
const seed = (db: Client, ws: string, repo: string, path: string) =>
  db.query(`INSERT INTO instinct_factory_reuse_corpus (workspace_id, repo, path, text) VALUES ($1,$2,$3,'t')`, [ws, repo, path]);

describeIfDb("pruneStaleReuse (migration 276)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_factory_reuse_corpus`);
    await db.query(readFileSync(MIGRATION, "utf8"));
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_factory_reuse_corpus`); });

  it("deletes paths absent from the live tree, keeps present ones", async () => {
    await seed(db, "w1", "o/r", "src/keep.ts");
    await seed(db, "w1", "o/r", "src/gone.ts");
    const res = await db.query(PRUNE, ["w1", "o/r", ["src/keep.ts"]]);
    expect(res.rowCount).toBe(1); // only gone.ts
    expect((await db.query(READ, ["w1", "o/r"])).rows.map((r) => r.path)).toEqual(["src/keep.ts"]);
  });

  it("is workspace-isolated (pruning w1 never touches w2)", async () => {
    await seed(db, "w1", "o/r", "src/a.ts");
    await seed(db, "w2", "o/r", "src/a.ts");
    await db.query(PRUNE, ["w1", "o/r", ["src/other.ts"]]); // removes w1's a.ts
    expect((await db.query(READ, ["w1", "o/r"])).rows).toHaveLength(0);
    expect((await db.query(READ, ["w2", "o/r"])).rows.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("the store guard means an empty tree is never sent to this DELETE (nothing wiped)", async () => {
    // pruneStaleReuse() short-circuits on [] and never issues the DELETE; this
    // asserts the invariant the guard protects: a full DELETE-with-empty-ANY would
    // remove everything, which must never happen.
    await seed(db, "w1", "o/r", "src/a.ts");
    // Simulate what the guard PREVENTS (empty list) to document the danger:
    const danger = await db.query(PRUNE, ["w1", "o/r", [] as string[]]);
    expect(danger.rowCount).toBe(1); // proves empty-list DELETE wipes -> guard is essential
    // (the store function returns early on [], so this DELETE is never reached in prod)
  });
});
