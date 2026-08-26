/**
 * The columns the Microsoft token lookup actually relies on, checked against a
 * REAL Postgres built from the REAL migrations.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-26 an admin route shipped with
 * `SELECT connected_by FROM instinct_ms_tokens WHERE workspace_id = $1`. That
 * table has no workspace_id column. The route would have thrown on its first
 * real request, and it was caught by querying production by hand rather than
 * by anything in CI.
 *
 * NOTHING ELSE COULD HAVE CAUGHT IT. The clause is valid TypeScript and a
 * valid-looking string. Unit tests mock `query`, so they assert we sent the
 * text we meant to send, which was exactly the thing that was wrong. This is
 * the same shape as the invite-accept bug in the suite next door: a query
 * naming an object that does not exist.
 *
 * So this pins the columns the token path depends on. A migration that renames
 * or drops one fails here rather than in production, and a query written
 * against a column somebody imagined fails the moment it is run for real.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { Client } from "pg";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

/**
 * What getValidToken reads, and what a caller may key on.
 *
 * connected_by and user_email are BOTH load-bearing: the lookup is two-tier so
 * a token survives the Instinct user being renamed or re-created, and dropping
 * either would silently reduce it to one tier.
 */
const REQUIRED_COLUMNS = [
  "access_token",
  "refresh_token",
  "expires_at",
  "connected_by",
  "user_email",
];

describeIfDb("instinct_ms_tokens", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it.each(REQUIRED_COLUMNS)("has the %s column the token path reads", async (column) => {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'instinct_ms_tokens' AND column_name = $1`,
      [column],
    );
    expect(rows).toHaveLength(1);
  });

  /* The column that did not exist, asserted as an ABSENCE so nobody
     reintroduces a query against it by memory. If the table ever genuinely
     becomes workspace-scoped, this test is the place that says so out loud and
     the routes get updated deliberately rather than by assumption. */
  it("is not workspace-scoped, which is why a query cannot filter on it", async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'instinct_ms_tokens' AND column_name = 'workspace_id'`,
    );
    expect(rows).toHaveLength(0);
  });
});
