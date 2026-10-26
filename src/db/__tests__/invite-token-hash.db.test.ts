/**
 * Team invite tokens hashed at rest (src/lib/team/invite-tokens.ts) against a
 * REAL Postgres. Proves:
 *   - the accept lookup finds an invite by the hash of the presented token,
 *     and still finds an invite that holds its raw token during rollout;
 *   - presenting the stored hash itself never opens a hashed invite;
 *   - the backfill hashes every raw token, leaves hashed ones alone, records
 *     one event, and a re-run is a no-op; a dry run writes nothing;
 *   - a link issued before the backfill still works after it.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { hashBearerToken, isHashedBearerToken } from "@/lib/crypto/token-hash";
import { INVITE_BY_TOKEN_SQL, hashInviteTokens, inviteLookupParams } from "@/lib/team/invite-tokens";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const RAW_OLD = "0f8e7a52-1c3d-4b6e-9a10-2f4c6d8e0b11"; // an invite created before hashing
const RAW_NEW = "6b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8"; // an invite created after

describeIfDb("team invite tokens hashed at rest", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_invites CASCADE`);
    await db.query(`DROP TABLE IF EXISTS instinct_events CASCADE`);
    /* Same shape as migrations 015 + 134 + 137 (FK omitted: no workspaces table here). */
    await db.query(`
      CREATE TABLE instinct_invites (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', invited_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days', workspace_id TEXT
      )`);
    await db.query(`CREATE TABLE instinct_events (id BIGSERIAL PRIMARY KEY, event_type TEXT, user_id TEXT, user_role TEXT, metadata JSONB, timestamp TIMESTAMPTZ)`);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP TABLE IF EXISTS instinct_invites CASCADE`);
      await db.query(`DROP TABLE IF EXISTS instinct_events CASCADE`);
    }
    await db?.end();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE instinct_invites`);
    await db.query(`TRUNCATE instinct_events`);
    await db.query(
      `INSERT INTO instinct_invites (id, email, role, token, invited_by, workspace_id)
       VALUES ('inv_old', 'old@example.test', 'ops', $1, 'u1', 'w1'),
              ('inv_new', 'new@example.test', 'ops', $2, 'u1', 'w1')`,
      [RAW_OLD, hashBearerToken(RAW_NEW)],
    );
  });

  const find = async (presented: string) => (await db.query(INVITE_BY_TOKEN_SQL, inviteLookupParams(presented))).rows.map((r) => r.id);

  it("finds a hashed invite by its raw token, and a not-yet-converted invite too", async () => {
    expect(await find(RAW_NEW)).toEqual(["inv_new"]);
    expect(await find(RAW_OLD)).toEqual(["inv_old"]);
    expect(await find("11111111-2222-4333-8444-555555555555")).toEqual([]);
  });

  it("never opens a hashed invite when the hash itself is presented", async () => {
    expect(await find(hashBearerToken(RAW_NEW))).toEqual([]);
  });

  it("a dry run counts and writes nothing", async () => {
    const r = await hashInviteTokens(db, { apply: false });
    expect(r).toMatchObject({ present: true, applied: false, rows: 2, alreadyHashed: 1, toHash: 1, hashed: 0, failed: 0 });
    expect((await db.query(`SELECT token FROM instinct_invites WHERE id = 'inv_old'`)).rows[0].token).toBe(RAW_OLD);
  });

  it("hashes every raw token, keeps outstanding links working, records one event, and a re-run is a no-op", async () => {
    const r = await hashInviteTokens(db, { apply: true });
    expect(r).toMatchObject({ applied: true, rows: 2, alreadyHashed: 1, toHash: 1, hashed: 1, failed: 0 });
    const tokens = (await db.query(`SELECT id, token FROM instinct_invites ORDER BY id`)).rows;
    expect(tokens.every((t) => isHashedBearerToken(t.token))).toBe(true);
    expect(tokens.find((t) => t.id === "inv_old")?.token).toBe(hashBearerToken(RAW_OLD));
    // The link emailed before the backfill still opens the invite.
    expect(await find(RAW_OLD)).toEqual(["inv_old"]);

    const events = (await db.query(`SELECT metadata FROM instinct_events WHERE event_type = 'security.invite_tokens_hashed'`)).rows;
    expect(events.map((e) => e.metadata)).toEqual([{ hashed: 1, already_hashed: 1, source: "operator_script" }]);

    const before = JSON.stringify(tokens);
    const again = await hashInviteTokens(db, { apply: true });
    expect(again).toMatchObject({ rows: 2, alreadyHashed: 2, toHash: 0, hashed: 0, failed: 0 });
    expect(JSON.stringify((await db.query(`SELECT id, token FROM instinct_invites ORDER BY id`)).rows)).toBe(before);
    expect((await db.query(`SELECT count(*)::int AS n FROM instinct_events`)).rows[0].n).toBe(1);
  });
});
