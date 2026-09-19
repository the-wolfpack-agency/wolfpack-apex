/**
 * Site-finding triage schema, run against a REAL Postgres built from the REAL
 * migration 258. Proves the lib's upsert + read SQL runs against the schema the
 * migration produces (unique-per-finding upsert, status CHECK, workspace scope)
 * and that the migration is idempotent.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATION = join(__dirname, "..", "migrations", "258_site_finding_triage.sql");

// Verbatim from src/lib/site-finding-triage.ts.
const UPSERT = `INSERT INTO instinct_site_finding_triage (workspace_id, finding_key, status, note, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, finding_key)
     DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`;
const READ = `SELECT finding_key, status, note, updated_at::text AS updated_at
     FROM instinct_site_finding_triage WHERE workspace_id = $1 AND finding_key = ANY($2)`;

describeIfDb("site finding triage schema (migration 258)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_site_finding_triage`);
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_site_finding_triage`); });

  it("upserts once per (workspace, finding) and updates in place", async () => {
    await db.query(UPSERT, ["w1", "fp1", "acknowledged", null, "u1"]);
    await db.query(UPSERT, ["w1", "fp1", "escalated", "real", "u2"]);
    const r = await db.query(READ, ["w1", ["fp1"]]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe("escalated");
    expect(r.rows[0].note).toBe("real");
  });

  it("is workspace-isolated", async () => {
    await db.query(UPSERT, ["w1", "fp1", "dismissed", null, "u1"]);
    expect((await db.query(READ, ["w2", ["fp1"]])).rows).toHaveLength(0);
  });

  it("rejects an unknown status via the CHECK constraint", async () => {
    await expect(db.query(UPSERT, ["w1", "fp1", "banished", null, "u1"])).rejects.toThrow();
  });
});
