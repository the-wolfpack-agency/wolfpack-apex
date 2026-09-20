/**
 * Delegation-issuer registry against a REAL Postgres built from migration 261.
 * Proves idempotency, the (workspace, issuer) upsert (secret rotation in place),
 * the algorithm CHECK, and workspace scoping. Skipped unless TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "261_delegation_issuers.sql");

// Verbatim from registerDelegationIssuer in src/lib/forcefield/principal.ts.
const UPSERT = `INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret, allowed_scopes, created_by)
     VALUES ($1, $2, 'hs256', $3, $4, $5)
     ON CONFLICT (workspace_id, issuer) DO UPDATE
       SET secret = EXCLUDED.secret, allowed_scopes = EXCLUDED.allowed_scopes, updated_at = now()`;

describeIfDb("delegation issuer registry (migration 261)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_delegation_issuers"); });

  it("upserts on (workspace, issuer): rotating a secret updates in place, not a 2nd row", async () => {
    await db.query(UPSERT, ["w1", "acme", "secret-one-value-16+", ["/catalog"], "u1"]);
    await db.query(UPSERT, ["w1", "acme", "secret-two-rotated!!", ["/catalog", "/api"], "u1"]);
    const r = await db.query("SELECT count(*)::int AS n, secret, allowed_scopes FROM instinct_delegation_issuers WHERE workspace_id='w1' AND issuer='acme' GROUP BY secret, allowed_scopes");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].secret).toBe("secret-two-rotated!!");
    expect(r.rows[0].allowed_scopes).toEqual(["/catalog", "/api"]);
  });

  it("scopes issuers by workspace: the same issuer name is distinct per workspace", async () => {
    await db.query(UPSERT, ["w1", "acme", "secret-w1-value-16!!", [], "u1"]);
    await db.query(UPSERT, ["w2", "acme", "secret-w2-value-16!!", [], "u2"]);
    const r = await db.query("SELECT workspace_id, secret FROM instinct_delegation_issuers WHERE issuer='acme' ORDER BY workspace_id");
    expect(r.rows.map((x) => x.workspace_id)).toEqual(["w1", "w2"]);
  });

  it("rejects an out-of-vocabulary algorithm via CHECK", async () => {
    await expect(
      db.query("INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret) VALUES ('w1','x','rs512','s')"),
    ).rejects.toThrow();
  });
});
