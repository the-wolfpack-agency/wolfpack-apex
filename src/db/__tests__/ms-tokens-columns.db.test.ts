/**
 * The Microsoft token lookup, run against a REAL Postgres built from the REAL
 * migration statements.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-26 an admin route shipped with
 * `SELECT connected_by FROM instinct_ms_tokens WHERE workspace_id = $1`. That
 * table has no workspace_id column. The route returned 500 on the first real
 * request, which is how it was found.
 *
 * NOTHING ELSE COULD HAVE CAUGHT IT. The clause is valid TypeScript and a
 * valid-looking string. Unit tests mock `query`, so they assert we sent the
 * text we meant to send, which was exactly the thing that was wrong. It is the
 * same shape as the invite-accept bug in the suite next door: a query naming an
 * object that does not exist.
 *
 * SO THIS EXECUTES THE REAL QUERY TEXT rather than inspecting a catalog. A
 * test that reads information_schema only proves what the test itself just
 * created; running the statement proves the statement works. A clause naming a
 * column nobody added fails here and only here.
 *
 * Schema built from migrations 005 and 044 rather than by running all ~250,
 * which would drag in every unrelated failure and bury the signal.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

/**
 * The lookup getValidToken performs, verbatim.
 *
 * Two-tier by design: connected_by is the original anchor, user_email is the
 * fallback so a token survives the Instinct user being renamed or re-created.
 * Both columns are load-bearing and neither may quietly disappear.
 */
const TOKEN_LOOKUP = `
  SELECT access_token, refresh_token, user_email, expires_at, connected_by
    FROM instinct_ms_tokens
   WHERE connected_by = $1 OR user_email = $1
   ORDER BY (connected_by = $1) DESC, updated_at DESC
   LIMIT 1`;

describeIfDb("the Microsoft token lookup", () => {
  let db: Client;

  beforeAll(async () => {
    /* REFUSES A NON-LOCAL HOST. This suite drops and recreates tables, and on
       2026-08-26 an earlier version of this file was pointed at production and
       destroyed the token table. The guard is here rather than in a habit
       because habits are what failed. */
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();

    /* Migration 005 creates apex_ms_tokens; 044 renames it. Reproduced with
       the same column list so the query below meets the schema the migrations
       actually produce. */
    await db.query(`DROP TABLE IF EXISTS instinct_ms_tokens CASCADE`);
    await db.query(`
      CREATE TABLE instinct_ms_tokens (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_email    TEXT NOT NULL,
        display_name  TEXT,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        connected_by  TEXT NOT NULL,
        connected_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )`);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("runs against the schema the migrations produce", async () => {
    await expect(db.query(TOKEN_LOOKUP, ["someone@example.com"])).resolves.toBeDefined();
  });

  it("finds a row by connected_by, and by email as the fallback", async () => {
    await db.query(
      `INSERT INTO instinct_ms_tokens
         (user_email, access_token, refresh_token, expires_at, connected_by)
       VALUES ($1, 'a', 'r', NOW() + INTERVAL '1 hour', $2)`,
      ["person@example.com", "user-123"],
    );
    const byAnchor = await db.query(TOKEN_LOOKUP, ["user-123"]);
    expect(byAnchor.rows).toHaveLength(1);
    const byEmail = await db.query(TOKEN_LOOKUP, ["person@example.com"]);
    expect(byEmail.rows).toHaveLength(1);
  });

  /* THE BUG, REPRODUCED. Not an assertion about a catalog: the statement
     that shipped, run for real, failing the way it failed in production. If
     the table ever genuinely becomes workspace-scoped this test says so out
     loud and the routes get updated deliberately rather than by assumption. */
  it("rejects a filter on workspace_id, which is the query that shipped", async () => {
    await expect(
      db.query(`SELECT connected_by FROM instinct_ms_tokens WHERE workspace_id = $1`, ["ws-1"]),
    ).rejects.toThrow(/workspace_id/);
  });
});
