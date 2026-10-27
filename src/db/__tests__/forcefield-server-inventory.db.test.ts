/**
 * "Is your server exposed?" against a REAL Postgres built from the REAL
 * migrations (284 ... 299 and the new 302). Runs the lib SQL itself:
 *   - 302 applies twice (idempotent) and creates the table, check and index;
 *   - the upsert keeps ONE row per tenant (latest wins, reports counted);
 *   - the alert claim is atomic: a second claim for the same key gets nothing;
 *   - alerted keys are pruned when the exposure is gone, so a regression alerts
 *     again; a failed send releases its claim;
 *   - the alert goes to a CONFIRMED address only (the live notify read);
 *   - deleting the tenant removes its inventory (ON DELETE CASCADE);
 *   - the dashboard read computes the findings from the stored versions.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here
 * (npm run test:db -- server-inventory).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

process.env.INSTINCT_JWT_SECRET = process.env.INSTINCT_JWT_SECRET || "db-test-secret-0123456789abcdef0123456789";

let db: Client;
jest.mock("@/lib/db", () => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params ?? []),
  safeQuery: async (sql: string, params?: unknown[]) => ({ rows: (await db.query(sql, params ?? [])).rows, fromCache: false }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));

import { receiveServerInventory, getServerExposure, CLAIM_ALERT_SQL } from "@/lib/forcefield-web/server-inventory";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATIONS = [
  "284_forcefield_tenants.sql",
  "285_forcefield_signup_requests.sql",
  "287_forcefield_tenant_shares_intel.sql",
  "288_forcefield_tenant_connector.sql",
  "289_forcefield_tenant_enforce.sql",
  "193_target_ownership_verification.sql",
  "298_forcefield_self_serve_onboarding.sql",
  "299_forcefield_plugin_connect.sql",
  "302_forcefield_server_inventory.sql",
];
const read = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");
const OLD = { phpVersion: "8.3.10", wordpressVersion: "6.8.3", serverSoftware: "Apache/2.4.62", plugins: [{ slug: "akismet", version: "5.3" }], pluginVersion: "0.4.0" };
const NEW = { ...OLD, phpVersion: "8.3.36" };

describeIfDb("Forcefield server inventory (real Postgres)", () => {
  let tenantId = "";
  const tenant = () => ({ id: tenantId, siteLabel: "acme.example" });
  const sent: string[] = [];
  const send = jest.fn(async (m: { to: string }) => { sent.push(m.to); return { delivered: true, reason: "ok" }; });

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS forcefield_server_inventory, forcefield_signup_requests, forcefield_tenants, instinct_target_verifications CASCADE`);
    for (const f of MIGRATIONS) await db.query(read(f));
    await db.query(read("302_forcefield_server_inventory.sql")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    sent.length = 0;
    send.mockClear();
    await db.query(`TRUNCATE forcefield_server_inventory, forcefield_tenants CASCADE`);
    const r = await db.query(
      `INSERT INTO forcefield_tenants (name, site_label, token_sha256, platform, notify_email, notify_status, notify_confirmed_at)
       VALUES ('Acme', 'acme.example', 'h-' || gen_random_uuid(), 'wordpress', 'owner@thewolfpack.agency', 'confirmed', now()) RETURNING id`,
    );
    tenantId = r.rows[0].id;
  });

  it("302 creates the table, the plugins check and the index (applied twice)", async () => {
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'forcefield_server_inventory'`);
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(
      ["alerted_keys", "first_received_at", "php_version", "plugin_version", "plugins", "received_at", "reports", "server_software", "tenant_id", "wordpress_version"].sort(),
    );
    expect((await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'forcefield_server_inventory_received_at'`)).rows).toHaveLength(1);
    await expect(db.query(`INSERT INTO forcefield_server_inventory (tenant_id, plugins) VALUES ($1, '{"a":1}'::jsonb)`, [tenantId])).rejects.toThrow(/plugins_array/);
  });

  it("keeps one row per tenant, latest wins; a new exposure emails the confirmed address once", async () => {
    const deps = { send, baseUrl: "https://ff.example" };
    const a = await receiveServerInventory(tenant(), OLD, deps);
    expect(a).toMatchObject({ ok: true, alert: "sent" });
    expect(sent).toEqual(["owner@thewolfpack.agency"]);
    const b = await receiveServerInventory(tenant(), OLD, deps);
    expect(b.alert).toBe("none");
    expect(send).toHaveBeenCalledTimes(1);
    const rows = await db.query(`SELECT php_version, reports, alerted_keys, plugins FROM forcefield_server_inventory`);
    expect(rows.rows).toEqual([{ php_version: "8.3.10", reports: 2, alerted_keys: ["php2shell:php"], plugins: [{ slug: "akismet", version: "5.3" }] }]);

    // Fixed: pruned. Regressed: alerts again.
    expect((await receiveServerInventory(tenant(), NEW, deps)).report!.status).toBe("ok");
    expect((await db.query(`SELECT alerted_keys FROM forcefield_server_inventory`)).rows[0].alerted_keys).toEqual([]);
    expect((await receiveServerInventory(tenant(), OLD, deps)).alert).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("the claim is atomic: the second claim for the same key gets nothing", async () => {
    await receiveServerInventory(tenant(), NEW, { send });
    const first = await db.query(CLAIM_ALERT_SQL, [tenantId, ["php2shell:php"]]);
    const second = await db.query(CLAIM_ALERT_SQL, [tenantId, ["php2shell:php"]]);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });

  it("a refused send releases the claim; an unconfirmed address is never mailed", async () => {
    const refused = await receiveServerInventory(tenant(), OLD, { send: async () => ({ delivered: false, reason: "recipient_not_allowlisted" }) });
    expect(refused.alert).toBe("not_delivered:recipient_not_allowlisted");
    expect((await db.query(`SELECT alerted_keys FROM forcefield_server_inventory`)).rows[0].alerted_keys).toEqual([]);

    await db.query(`UPDATE forcefield_tenants SET notify_status = 'pending'`);
    const pending = await receiveServerInventory(tenant(), OLD, { send });
    expect(pending.alert).toBe("not_confirmed");
    expect(send).not.toHaveBeenCalled();
  });

  it("the dashboard read computes findings from the stored versions; tenant delete cascades", async () => {
    expect(await getServerExposure(tenantId)).toEqual({ report: null });
    await receiveServerInventory(tenant(), { ...OLD, phpVersion: "7.4.33", plugins: [{ slug: "wp-file-manager", version: "6.8" }] }, { send });
    const v = await getServerExposure(tenantId);
    expect(v!.report).toMatchObject({ status: "exposed", phpVersion: "7.4.33" });
    expect(v!.report!.findings.filter((f) => f.state === "exposed").map((f) => f.key)).toEqual(["php2shell:php", "wp_file_manager_rce:wp-file-manager"]);
    await db.query(`DELETE FROM forcefield_tenants WHERE id = $1`, [tenantId]);
    expect((await db.query(`SELECT count(*)::int AS n FROM forcefield_server_inventory`)).rows[0].n).toBe(0);
  });
});
