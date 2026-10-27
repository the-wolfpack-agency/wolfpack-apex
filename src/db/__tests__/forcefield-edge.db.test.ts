/**
 * Migration 301 (Forcefield Edge), against a REAL Postgres. Proves the columns
 * and table are added, the migration is idempotent, one hostname can never
 * belong to two tenants, hostnames are stored normalized, deleting a tenant
 * removes its hostnames, the rollback is clean, and the exact SQL the Edge
 * module runs (claim, status cache, per-host resolve) works on the produced
 * schema. Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { addEdgeHostname, recordHostnameStatus, resolveEdgeSiteByHost, setEdgeOrigin, type EdgeQuery } from "@/lib/forcefield-web/edge-sites";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const M = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");

describeIfDb("forcefield edge schema (migration 301)", () => {
  let db: Client;
  let q: EdgeQuery;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    q = (async (sql: string, params?: unknown[]) => (await db.query(sql, params ?? [])).rows) as EdgeQuery;
    await db.query(`DROP TABLE IF EXISTS forcefield_edge_hostnames`);
    await db.query(`DROP TABLE IF EXISTS forcefield_tenants CASCADE`);
    // 284 cross-ALTERs site_analytics_events; stub it (self-contained db test).
    await db.query(`CREATE TABLE IF NOT EXISTS site_analytics_events (id bigserial PRIMARY KEY, props jsonb)`);
    for (const f of ["284_forcefield_tenants.sql", "286_forcefield_tenant_billing.sql", "288_forcefield_tenant_connector.sql", "289_forcefield_tenant_enforce.sql"]) {
      await db.query(M(f));
    }
    await db.query(M("301_forcefield_edge.sql"));
    await db.query(M("301_forcefield_edge.sql")); // idempotent
  });
  afterAll(async () => {
    // Leave no dependent of forcefield_tenants behind for the next db test file.
    await db?.query(`DROP TABLE IF EXISTS forcefield_edge_hostnames`).catch(() => {});
    await db?.end();
  });

  const tenant = async (label: string) =>
    (await db.query(`INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ($1, $1, md5(random()::text)) RETURNING id`, [label])).rows[0].id as string;

  it("adds the tenant columns, nullable", async () => {
    const id = await tenant("cols.example");
    const r = await db.query(`SELECT edge_origin_url, edge_origin_secret_sealed, edge_secret_rotated_at FROM forcefield_tenants WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ edge_origin_url: null, edge_origin_secret_sealed: null, edge_secret_rotated_at: null });
  });

  it("one hostname belongs to one tenant (PRIMARY KEY)", async () => {
    const a = await tenant("a.example");
    const b = await tenant("b.example");
    await db.query(`INSERT INTO forcefield_edge_hostnames (hostname, tenant_id) VALUES ('shared.example.com', $1)`, [a]);
    await expect(db.query(`INSERT INTO forcefield_edge_hostnames (hostname, tenant_id) VALUES ('shared.example.com', $1)`, [b])).rejects.toThrow(/duplicate key/);
  });

  it("refuses a non-normalized hostname (uppercase, port, trailing dot)", async () => {
    const a = await tenant("norm.example");
    for (const bad of ["Upper.Example.com", "a.example.com:443", "a.example.com."]) {
      await expect(db.query(`INSERT INTO forcefield_edge_hostnames (hostname, tenant_id) VALUES ($1, $2)`, [bad, a])).rejects.toThrow(/forcefield_edge_hostnames_normalized/);
    }
  });

  it("deleting a tenant removes its hostnames (no orphan routes)", async () => {
    const a = await tenant("gone.example");
    await db.query(`INSERT INTO forcefield_edge_hostnames (hostname, tenant_id) VALUES ('gone.example.com', $1)`, [a]);
    await db.query(`DELETE FROM forcefield_tenants WHERE id = $1`, [a]);
    expect((await db.query(`SELECT 1 FROM forcefield_edge_hostnames WHERE hostname = 'gone.example.com'`)).rowCount).toBe(0);
  });

  it("the module's own SQL runs on this schema: set origin, claim, cache status, resolve", async () => {
    const id = await tenant("client.example");
    await db.query(`UPDATE forcefield_tenants SET enforce_enabled = true, subscription_status = 'active' WHERE id = $1`, [id]);
    const set = await setEdgeOrigin(id, "https://origin.client.example", {}, q);
    expect(set?.secret).toMatch(/^ffe_/);
    const stored = (await db.query(`SELECT edge_origin_secret_sealed FROM forcefield_tenants WHERE id = $1`, [id])).rows[0].edge_origin_secret_sealed as string;
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(set!.secret!);

    expect(await addEdgeHostname(id, "www.client.example", q)).toEqual({ ok: true, hostname: "www.client.example", created: true });
    expect(await addEdgeHostname(id, "www.client.example", q)).toEqual({ ok: true, hostname: "www.client.example", created: false });
    const other = await tenant("other.example");
    await setEdgeOrigin(other, "https://origin.other.example", {}, q);
    expect(await addEdgeHostname(other, "www.client.example", q)).toEqual({ ok: false, error: "hostname_in_use" });

    expect(await recordHostnameStatus(id, "www.client.example", true, [{ type: "CNAME", name: "www", value: "x.vercel-dns-017.com", purpose: "route" }], q)).toBe(true);
    const row = (await db.query(`SELECT verified, dns_records FROM forcefield_edge_hostnames WHERE hostname = 'www.client.example'`)).rows[0];
    expect(row.verified).toBe(true);
    expect(row.dns_records[0].value).toBe("x.vercel-dns-017.com");

    const site = await resolveEdgeSiteByHost("WWW.client.example", q);
    expect(site).toMatchObject({ tenantId: id, siteLabel: "client.example", originUrl: "https://origin.client.example", originSecret: set!.secret, enforce: true });

    await db.query(`UPDATE forcefield_tenants SET status = 'disabled' WHERE id = $1`, [id]);
    expect(await resolveEdgeSiteByHost("www.client.example", q)).toBeNull(); // a disabled tenant is never served
  });

  it("the rollback removes everything 301 added, and 301 re-applies cleanly", async () => {
    await db.query(M("301_forcefield_edge.down.sql"));
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'forcefield_tenants' AND column_name LIKE 'edge_%'`);
    expect(cols.rowCount).toBe(0);
    expect((await db.query(`SELECT to_regclass('forcefield_edge_hostnames') AS t`)).rows[0].t).toBeNull();
    await db.query(M("301_forcefield_edge.sql"));
    expect((await db.query(`SELECT to_regclass('forcefield_edge_hostnames') AS t`)).rows[0].t).not.toBeNull();
  });
});
