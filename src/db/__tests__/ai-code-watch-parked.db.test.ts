/**
 * The watcher's parking memory, run against a REAL Postgres built from the REAL
 * migration 290 with the store's own SQL (watch-parking.ts). Proves: the migration
 * is idempotent; a park is found only at the head commit it was recorded at; a
 * re-park at a new commit replaces the old one (one row per PR); and a park is
 * workspace-isolated, so one client's dead end never hides another client's PR.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { PARK_SQL, IS_PARKED_SQL } from "@/lib/ai-code/watch-parking";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "290_ai_code_watch_parked.sql");

describeIfDb("ai-code watch parking (migration 290)", () => {
  let db: Client;
  const parked = async (ws: string, repo: string, pr: number, sha: string) =>
    (await db.query(IS_PARKED_SQL, [ws, repo, pr, sha])).rows.length > 0;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_ai_code_watch_parked`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_ai_code_watch_parked`); });

  it("a park is found at its head commit and not at any other", async () => {
    await db.query(PARK_SQL, ["w1", "o/r", 6, "aaa", "escalate_human", "re-author produced no fix (empty)"]);
    expect(await parked("w1", "o/r", 6, "aaa")).toBe(true);
    expect(await parked("w1", "o/r", 6, "bbb")).toBe(false);
  });

  it("re-parking at a new commit replaces the old park: one row per PR", async () => {
    await db.query(PARK_SQL, ["w1", "o/r", 6, "aaa", "escalate_human", null]);
    await db.query(PARK_SQL, ["w1", "o/r", 6, "bbb", "escalate_human", "again"]);
    expect(await parked("w1", "o/r", 6, "aaa")).toBe(false);
    expect(await parked("w1", "o/r", 6, "bbb")).toBe(true);
    expect((await db.query(`SELECT count(*)::int n FROM instinct_ai_code_watch_parked`)).rows[0].n).toBe(1);
  });

  it("is workspace- and repo-isolated", async () => {
    await db.query(PARK_SQL, ["w1", "o/r", 6, "aaa", "escalate_human", null]);
    expect(await parked("w2", "o/r", 6, "aaa")).toBe(false);
    expect(await parked("w1", "o/other", 6, "aaa")).toBe(false);
    expect(await parked("w1", "o/r", 7, "aaa")).toBe(false);
  });
});
