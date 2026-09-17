/**
 * OGIAM entitlements, against a REAL Postgres built from the REAL migration 254.
 * Proves the override round-trips, the upsert replaces on the (workspace, feature)
 * PK, clear deletes, and workspace isolation.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const UPSERT = `
  INSERT INTO instinct_org_entitlements(workspace_id, feature, enabled, updated_by, updated_at)
  VALUES ($1,$2,$3,$4, now())
  ON CONFLICT (workspace_id, feature)
  DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
const READ = `SELECT enabled FROM instinct_org_entitlements WHERE workspace_id = $1 AND feature = $2`;
const DEL = `DELETE FROM instinct_org_entitlements WHERE workspace_id = $1 AND feature = $2`;

describeIfDb("OGIAM org entitlements", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_org_entitlements CASCADE`);
    await db.query(readFileSync(join(__dirname, "..", "migrations", "254_org_entitlements.sql"), "utf8"));
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_org_entitlements`); });

  it("stores and reads back an override", async () => {
    await db.query(UPSERT, ["w1", "forcefield", false, "u1"]);
    expect((await db.query(READ, ["w1", "forcefield"])).rows[0].enabled).toBe(false);
  });

  it("upsert replaces on (workspace_id, feature) rather than duplicating", async () => {
    await db.query(UPSERT, ["w1", "forcefield", false, "u1"]);
    await db.query(UPSERT, ["w1", "forcefield", true, "u2"]);
    const { rows } = await db.query(`SELECT enabled, updated_by FROM instinct_org_entitlements WHERE workspace_id='w1' AND feature='forcefield'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].updated_by).toBe("u2");
  });

  it("clear deletes the override", async () => {
    await db.query(UPSERT, ["w1", "secure_agent", false, "u1"]);
    await db.query(DEL, ["w1", "secure_agent"]);
    expect((await db.query(READ, ["w1", "secure_agent"])).rows).toHaveLength(0);
  });

  it("is workspace-isolated", async () => {
    await db.query(UPSERT, ["w1", "forcefield", false, "u1"]);
    expect((await db.query(READ, ["w2", "forcefield"])).rows).toHaveLength(0);
  });
});
