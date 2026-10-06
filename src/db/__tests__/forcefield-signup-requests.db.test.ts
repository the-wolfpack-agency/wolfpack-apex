/**
 * Forcefield signup-requests schema, run against a REAL Postgres built from the
 * REAL migration 285. Proves the lib's INSERT (with the partial-unique ON CONFLICT
 * that collapses duplicate OPEN requests) and the approve/reject UPDATEs run
 * against the schema the migration produces, and that the migration is idempotent.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "285_forcefield_signup_requests.sql");

// Verbatim from src/lib/forcefield-web/signup.ts (createSignupRequest).
const INSERT = `INSERT INTO forcefield_signup_requests (name, email, site_url, note, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(email), lower(site_url)) WHERE status = 'pending' DO NOTHING
       RETURNING id`;

describeIfDb("forcefield signup requests schema (migration 285)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS forcefield_signup_requests`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE forcefield_signup_requests`); });

  it("inserts a pending request and defaults status=pending", async () => {
    const r = await db.query(INSERT, ["Dana", "dana@acme.com", "acme.com", null, "iphash"]);
    expect(r.rows).toHaveLength(1);
    const row = await db.query(`SELECT status FROM forcefield_signup_requests WHERE id = $1`, [r.rows[0].id]);
    expect(row.rows[0].status).toBe("pending");
  });

  it("collapses a duplicate OPEN request (same email+site) via the partial unique index", async () => {
    const first = await db.query(INSERT, ["Dana", "dana@acme.com", "acme.com", null, "h"]);
    expect(first.rows).toHaveLength(1);
    const dup = await db.query(INSERT, ["Dana Again", "DANA@acme.com", "ACME.com", "note", "h2"]);
    expect(dup.rows).toHaveLength(0); // DO NOTHING -> no RETURNING row
    const count = await db.query(`SELECT count(*)::int AS n FROM forcefield_signup_requests`);
    expect(count.rows[0].n).toBe(1);
  });

  it("allows a NEW open request for the same site once the prior is approved", async () => {
    const first = await db.query(INSERT, ["Dana", "dana@acme.com", "acme.com", null, "h"]);
    await db.query(`UPDATE forcefield_signup_requests SET status = 'approved', tenant_id = gen_random_uuid() WHERE id = $1`, [first.rows[0].id]);
    const again = await db.query(INSERT, ["Dana", "dana@acme.com", "acme.com", null, "h"]);
    expect(again.rows).toHaveLength(1); // the partial index only constrains pending rows
  });

  it("reject marks the row without deleting it (audit trail preserved)", async () => {
    const r = await db.query(INSERT, ["Dana", "dana@acme.com", "acme.com", null, "h"]);
    await db.query(`UPDATE forcefield_signup_requests SET status = 'rejected', reviewed_by = 'op-1', reviewed_at = now() WHERE id = $1`, [r.rows[0].id]);
    const row = await db.query(`SELECT status, reviewed_by FROM forcefield_signup_requests WHERE id = $1`, [r.rows[0].id]);
    expect(row.rows[0].status).toBe("rejected");
    expect(row.rows[0].reviewed_by).toBe("op-1");
  });
});
