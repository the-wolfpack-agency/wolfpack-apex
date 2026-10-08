/**
 * Forcefield tenant registry, run against a REAL Postgres built from the REAL
 * migrations (284 base + 286 billing + 287 shares_intel + 288 connector + 289
 * enforce). Proves the lib's SQL (src/lib/forcefield-web/tenants.ts) actually runs
 * against the schema those migrations produce - the gap that unit tests with an
 * injected query fn cannot catch (a column rename or a typo passes unit tests and
 * fails only in production). Also pins: the token is stored HASHED and round-trips;
 * platform / shares_intel / enforce defaults and persistence; active-only
 * resolution; and that the migrations are idempotent (re-applying is a no-op).
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import {
  createForcefieldTenant,
  resolveTenantByToken,
  listForcefieldTenants,
  setTenantPlatform,
  setTenantEnforce,
  setTenantSharesIntel,
  setTenantStatus,
  hashToken,
  type TenantQuery,
} from "@/lib/forcefield-web/tenants";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATIONS = [
  "284_forcefield_tenants.sql",
  "286_forcefield_tenant_billing.sql",
  "287_forcefield_tenant_shares_intel.sql",
  "288_forcefield_tenant_connector.sql",
  "289_forcefield_tenant_enforce.sql",
];

function readMigration(file: string): string {
  return readFileSync(join(__dirname, "..", "migrations", file), "utf8");
}

describeIfDb("Forcefield tenant registry (real Postgres)", () => {
  let db: Client;
  // Run the REAL lib SQL against the real connection.
  const q: TenantQuery = async (sql, params) => (await db.query(sql, params ?? [])).rows as never;

  async function applyMigrations() {
    // 284 ALTERs site_analytics_events; stub it minimally so the ALTER applies.
    await db.query(`CREATE TABLE IF NOT EXISTS site_analytics_events (id BIGSERIAL PRIMARY KEY)`);
    for (const f of MIGRATIONS) await db.query(readMigration(f));
  }

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS forcefield_tenants CASCADE`);
    await applyMigrations();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE forcefield_tenants`); });

  it("stores the token HASHED (never raw) and resolves it back with schema defaults", async () => {
    const created = await createForcefieldTenant({ name: "Acme Inc", siteLabel: "acme", platform: "vercel" }, q);
    expect(created).not.toBeNull();
    const token = created!.token;
    expect(token.startsWith("ff_")).toBe(true);

    // What is stored is the HASH, not the token.
    const { rows } = await db.query<{ token_sha256: string }>(`SELECT token_sha256 FROM forcefield_tenants`);
    expect(rows[0].token_sha256).toBe(hashToken(token));
    expect(rows[0].token_sha256).not.toContain(token);

    // Resolve by the RAW token -> the tenant, carrying the schema defaults.
    const t = await resolveTenantByToken(token, q);
    expect(t).not.toBeNull();
    expect(t!.siteLabel).toBe("acme");
    expect(t!.platform).toBe("vercel");
    expect(t!.sharesIntel).toBe(true);     // migration 287 default true
    expect(t!.enforceEnabled).toBe(false); // migration 289 default false (watch-first)
  });

  it("persists platform, enforce, and intel changes and reflects them on resolve + listing", async () => {
    const created = await createForcefieldTenant({ name: "Acme", siteLabel: "acme" }, q);
    const id = created!.tenant.id;
    expect(created!.tenant.platform).toBe("generic"); // default when unspecified

    expect(await setTenantPlatform(id, "cloudflare", q)).toBe(true);
    expect(await setTenantEnforce(id, true, q)).toBe(true);
    expect(await setTenantSharesIntel(id, false, q)).toBe(true);

    const t = await resolveTenantByToken(created!.token, q);
    expect(t!.platform).toBe("cloudflare");
    expect(t!.enforceEnabled).toBe(true);
    expect(t!.sharesIntel).toBe(false);

    const [listed] = await listForcefieldTenants(q);
    expect(listed.platform).toBe("cloudflare");
    expect(listed.enforceEnabled).toBe(true);
    expect(listed.sharesIntel).toBe(false);
    // The listing never leaks the token or its hash.
    expect(JSON.stringify(listed)).not.toContain(created!.token);
    expect(listed).not.toHaveProperty("token");
    expect(listed).not.toHaveProperty("token_sha256");
  });

  it("resolveTenantByToken is active-only: a disabled tenant's token stops resolving", async () => {
    const created = await createForcefieldTenant({ name: "Acme", siteLabel: "acme" }, q);
    expect(await resolveTenantByToken(created!.token, q)).not.toBeNull();
    await setTenantStatus(created!.tenant.id, "disabled", q);
    expect(await resolveTenantByToken(created!.token, q)).toBeNull();
  });

  it("enforces the unique token-hash index (no two tenants share a token)", async () => {
    const token = "ff_fixed_token_for_collision";
    await db.query(`INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ($1,$2,$3)`, ["A", "a", hashToken(token)]);
    await expect(
      db.query(`INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ($1,$2,$3)`, ["B", "b", hashToken(token)]),
    ).rejects.toThrow();
  });

  it("the additive migrations are idempotent (re-applying is a no-op)", async () => {
    await expect(applyMigrations()).resolves.not.toThrow();
    // columns still present + usable after a second apply
    const created = await createForcefieldTenant({ name: "Acme", siteLabel: "acme", platform: "hosted" }, q);
    expect((await resolveTenantByToken(created!.token, q))!.platform).toBe("hosted");
  });
});
