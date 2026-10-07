/**
 * Migration 286 (forcefield tenant billing columns), against a REAL Postgres.
 * Proves the columns are added with safe defaults, the migration is idempotent,
 * and setTenantBilling's UPDATE runs against the produced schema. Skipped unless
 * TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const M284 = join(__dirname, "..", "migrations", "284_forcefield_tenants.sql");
const M286 = join(__dirname, "..", "migrations", "286_forcefield_tenant_billing.sql");

describeIfDb("forcefield tenant billing schema (migration 286)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS forcefield_tenants`);
    // 284 cross-ALTERs site_analytics_events; these db-tests are self-contained
    // (not pre-migrated), so stub that table first (CREATE IF NOT EXISTS is a no-op
    // when it already exists). We are testing 286's columns, not 178's table.
    await db.query(`CREATE TABLE IF NOT EXISTS site_analytics_events (id bigserial PRIMARY KEY, props jsonb)`);
    await db.query(readFileSync(M284, "utf8"));
    const m286 = readFileSync(M286, "utf8");
    await db.query(m286);
    await db.query(m286); // idempotent
  });
  afterAll(async () => { await db?.end(); });

  it("adds the billing columns with safe defaults", async () => {
    const r = await db.query(
      `INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ('Acme','acme.com','h')
       RETURNING plan, subscription_status, billing_provider, billing_ref, current_period_end`,
    );
    expect(r.rows[0]).toMatchObject({ plan: "none", subscription_status: "none", billing_provider: "manual", billing_ref: null, current_period_end: null });
  });

  it("updates licensing state in place (the setTenantBilling path)", async () => {
    const ins = await db.query(`INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ('B','b.com','h2') RETURNING id`);
    const id = ins.rows[0].id;
    await db.query(`UPDATE forcefield_tenants SET plan='growth', subscription_status='active', billing_provider='stripe', billing_ref='sub_1' WHERE id=$1`, [id]);
    const row = await db.query(`SELECT plan, subscription_status, billing_provider, billing_ref FROM forcefield_tenants WHERE id=$1`, [id]);
    expect(row.rows[0]).toMatchObject({ plan: "growth", subscription_status: "active", billing_provider: "stripe", billing_ref: "sub_1" });
  });
});
