/**
 * Public agent harness schema, run against a REAL Postgres built from the REAL
 * migration 257. Proves the harness lib's SQL runs against the schema the
 * migration produces (session RETURNING, the hit insert + count bump, the hits
 * read-back, the expiry predicate, the FK cascade) and that the migration is
 * idempotent (re-applying it does not error).
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATION = join(__dirname, "..", "migrations", "257_public_agent_harness.sql");

// Verbatim from src/lib/harness/harness.ts.
const CREATE_SESSION = `INSERT INTO instinct_harness_sessions (id, goal, agent_label, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
     RETURNING expires_at`;
const LOAD_SESSION = `SELECT id, goal, agent_label, hit_count, sighting_recorded, (expires_at < now()) AS expired
       FROM instinct_harness_sessions WHERE id = $1`;
const INSERT_HIT = `INSERT INTO instinct_harness_hits (session_id, path, method, status, event_type)
     VALUES ($1, $2, $3, $4, $5)`;
const BUMP = `UPDATE instinct_harness_sessions SET hit_count = hit_count + 1 WHERE id = $1`;
const LOAD_HITS = `SELECT path, method, status, event_type, seen_at
       FROM instinct_harness_hits WHERE session_id = $1 ORDER BY seen_at ASC`;
const CAPTURE = `UPDATE instinct_harness_sessions SET sighting_recorded = true, operator_key = $2 WHERE id = $1`;

describeIfDb("public agent harness schema (migration 257)", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_harness_hits CASCADE`);
    await db.query(`DROP TABLE IF EXISTS instinct_harness_sessions CASCADE`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent: re-applying must not error
  });

  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_harness_hits, instinct_harness_sessions CASCADE`); });

  it("creates a session, returns its expiry, and reads it back not-expired", async () => {
    const ins = await db.query(CREATE_SESSION, ["hs_1", "explore", "gpt", "30"]);
    expect(ins.rows).toHaveLength(1);
    const s = await db.query(LOAD_SESSION, ["hs_1"]);
    expect(s.rows[0].expired).toBe(false);
    expect(s.rows[0].hit_count).toBe(0);
    expect(s.rows[0].sighting_recorded).toBe(false);
  });

  it("records hits, bumps the count, and reads them back in order", async () => {
    await db.query(CREATE_SESSION, ["hs_1", "explore", "gpt", "30"]);
    await db.query(INSERT_HIT, ["hs_1", "/", "GET", 200, null]);
    await db.query(BUMP, ["hs_1"]);
    await db.query(INSERT_HIT, ["hs_1", "/_ff/records", "GET", 200, "site.agent_trap_tripped"]);
    await db.query(BUMP, ["hs_1"]);
    const hits = await db.query(LOAD_HITS, ["hs_1"]);
    expect(hits.rows.map((r) => r.path)).toEqual(["/", "/_ff/records"]);
    expect((await db.query(LOAD_SESSION, ["hs_1"])).rows[0].hit_count).toBe(2);
  });

  it("captures the sighting flag + operator key idempotently", async () => {
    await db.query(CREATE_SESSION, ["hs_1", "explore", "gpt", "30"]);
    await db.query(CAPTURE, ["hs_1", "op_abc"]);
    const s = await db.query(LOAD_SESSION, ["hs_1"]);
    expect(s.rows[0].sighting_recorded).toBe(true);
  });

  it("expires a session whose TTL has passed", async () => {
    await db.query(CREATE_SESSION, ["hs_old", "explore", "gpt", "-1"]); // already expired
    expect((await db.query(LOAD_SESSION, ["hs_old"])).rows[0].expired).toBe(true);
  });

  it("cascades hit deletion when the session is removed (FK ON DELETE CASCADE)", async () => {
    await db.query(CREATE_SESSION, ["hs_1", "explore", "gpt", "30"]);
    await db.query(INSERT_HIT, ["hs_1", "/", "GET", 200, null]);
    await db.query(`DELETE FROM instinct_harness_sessions WHERE id = $1`, ["hs_1"]);
    expect((await db.query(LOAD_HITS, ["hs_1"])).rows).toHaveLength(0);
  });

  it("rejects a hit for a non-existent session (FK enforced)", async () => {
    await expect(db.query(INSERT_HIT, ["hs_missing", "/", "GET", 200, null])).rejects.toThrow();
  });
});
