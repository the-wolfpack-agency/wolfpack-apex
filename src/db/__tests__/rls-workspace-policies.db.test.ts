/**
 * Migrations 296 + 297 (workspace RLS policies), run against a REAL Postgres.
 *
 * Proves, with the migration files exactly as they ship:
 *   1. a NON-OWNER role without BYPASSRLS sees only its own workspace: a
 *      cross-tenant read returns 0 rows, an unset context returns 0 rows, a
 *      cross-tenant UPDATE/DELETE touches 0 rows, and WITH CHECK refuses a row
 *      tagged for another workspace;
 *   2. the app's CURRENT connection shape is unaffected: the table owner (even
 *      one WITHOUT BYPASSRLS) still sees every row, because no table is FORCEd.
 *      That is the property that makes the deploy safe on live data;
 *   3. app.rls_system = 'on' admits cross-workspace system work;
 *   4. both migrations are idempotent (re-run changes nothing) and reversible
 *      (down then up lands in the same state);
 *   5. the real db.ts query() path with INSTINCT_RLS_SESSION_CONTEXT=on,
 *      connected as the non-owner role, filters by the bound workspace.
 *
 * Built in a private schema with a minimal stand-in for every table the
 * migrations name (id + workspace_id of the real type), so the test runs the
 * real files without replaying ~300 migrations. The fresh-install step of the
 * DB contract workflow separately proves 296/297 apply on the full chain.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here, and it
 * refuses a non-local host (it creates roles and drops a schema).
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, "..", "migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const UP_296 = read("296_rls_workspace_policies.sql");
const UP_297 = read("297_rls_workspace_policies_remaining.sql");
const DOWN_296 = read("296_rls_workspace_policies.down.sql");
const DOWN_297 = read("297_rls_workspace_policies_remaining.down.sql");

/** Tables a migration touches, read from its own ALTER statements. */
function tablesOf(sql: string): string[] {
  return [...new Set([...sql.matchAll(/^ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY;/gm)].map((m) => m[1]))];
}
const T296 = tablesOf(UP_296);
const T297 = tablesOf(UP_297);
const UUID_TABLES = new Set(["instinct_spec_diff_runs"]);

const SUFFIX = `${process.pid}`;
const SCHEMA = `rls_probe_${SUFFIX}`;
const APP_ROLE = `rls_app_${SUFFIX}`; // the future NOBYPASSRLS app role
const OWNER_ROLE = `rls_owner_${SUFFIX}`; // an owner WITHOUT BYPASSRLS
const APP_PASSWORD = `pw_${SUFFIX}_rls`;

const WS_A = "ws-a";
const WS_B = "ws-b";
const UUID_A = "00000000-0000-0000-0000-00000000000a";
const UUID_B = "00000000-0000-0000-0000-00000000000b";

describeIfDb("migrations 296/297: workspace RLS policies", () => {
  let admin: Client;

  async function asRole<T>(role: string, ws: string | null, fn: (c: Client) => Promise<T>, system = false): Promise<T> {
    await admin.query("BEGIN");
    try {
      await admin.query(`SET LOCAL ROLE ${role}`);
      if (ws !== null) await admin.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
      if (system) await admin.query("SELECT set_config('app.rls_system', 'on', true)");
      const out = await fn(admin);
      await admin.query("ROLLBACK");
      return out;
    } catch (err) {
      await admin.query("ROLLBACK");
      throw err;
    }
  }

  async function policyState(): Promise<string> {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              coalesce(string_agg(p.polname || '=' || pg_get_expr(p.polqual, p.polrelid), ';' ORDER BY p.polname), '') AS pols
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = $1 AND c.relkind = 'r'
        GROUP BY 1, 2, 3 ORDER BY 1`,
      [SCHEMA],
    );
    return JSON.stringify(rows);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    for (const r of [APP_ROLE, OWNER_ROLE]) await admin.query(`DROP ROLE IF EXISTS ${r}`);
    await admin.query(`CREATE ROLE ${OWNER_ROLE} NOLOGIN NOBYPASSRLS`);
    await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);

    // The state production is in before 296: the tripwire tables have RLS on
    // with the permissive <t>_all policy; the rest have no RLS at all.
    for (const t of [...T296, ...T297]) {
      const type = UUID_TABLES.has(t) ? "uuid" : "text";
      await admin.query(`CREATE TABLE ${t} (id text PRIMARY KEY, workspace_id ${type})`);
      const [a, b] = type === "uuid" ? [UUID_A, UUID_B] : [WS_A, WS_B];
      await admin.query(`INSERT INTO ${t} VALUES ('a1', $1), ('a2', $1), ('b1', $2)`, [a, b]);
      await admin.query(`ALTER TABLE ${t} OWNER TO ${OWNER_ROLE}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE}`);
    }
    for (const t of T296) {
      await admin.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`CREATE POLICY ${t}_all ON ${t} FOR ALL USING (true) WITH CHECK (true)`);
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE}, ${OWNER_ROLE}`);
    await admin.query(UP_296);
    await admin.query(UP_297);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => undefined);
    for (const r of [APP_ROLE, OWNER_ROLE]) await admin.query(`DROP ROLE IF EXISTS ${r}`);
    await admin.end();
  });

  it("covers the tables it says it covers, and no table is FORCEd", async () => {
    expect(T296.length).toBeGreaterThan(15);
    expect(T297.length).toBeGreaterThan(40);
    expect(T296).toContain("instinct_admin_mfa");
    expect(T296).not.toContain("instinct_gate_api_keys");
    expect(T297).not.toContain("instinct_team_members");
    expect(T297).not.toContain("instinct_invites");
    const { rows } = await admin.query(
      `SELECT count(*)::int AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relforcerowsecurity`,
      [SCHEMA],
    );
    expect(rows[0].forced).toBe(0);
    for (const sql of [UP_296, UP_297]) expect(sql).not.toMatch(/^\s*ALTER TABLE \w+ FORCE ROW LEVEL SECURITY/im);
    for (const sql of [UP_296, UP_297]) expect(sql).not.toMatch(/^\s*CREATE ROLE/im);
  });

  it("a non-owner role sees only its own workspace, on every covered table", async () => {
    for (const t of [...T296, ...T297]) {
      const ws = UUID_TABLES.has(t) ? UUID_A : WS_A;
      const ids = await asRole(APP_ROLE, ws, async (c) => (await c.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map((r) => r.id));
      expect({ t, ids }).toEqual({ t, ids: ["a1", "a2"] });
    }
  });

  it("a cross-tenant read returns 0 rows", async () => {
    const n = await asRole(APP_ROLE, WS_A, async (c) => (await c.query(`SELECT id FROM instinct_admin_mfa WHERE workspace_id = $1`, [WS_B])).rowCount);
    expect(n).toBe(0);
    const m = await asRole(APP_ROLE, WS_A, async (c) => (await c.query(`SELECT id FROM lms_courses WHERE id = 'b1'`)).rowCount);
    expect(m).toBe(0);
  });

  it("with no workspace context the non-owner role reads 0 rows (fail closed)", async () => {
    for (const t of ["instinct_admin_mfa", "lms_courses", "ogiam_decisions"]) {
      const n = await asRole(APP_ROLE, null, async (c) => (await c.query(`SELECT id FROM ${t}`)).rowCount);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
    const empty = await asRole(APP_ROLE, "", async (c) => (await c.query(`SELECT id FROM lms_courses`)).rowCount);
    expect(empty).toBe(0);
  });

  it("a cross-tenant UPDATE and DELETE touch 0 rows", async () => {
    const res = await asRole(APP_ROLE, WS_A, async (c) => {
      const u = await c.query(`UPDATE lms_courses SET id = id WHERE id = 'b1'`);
      const d = await c.query(`DELETE FROM instinct_admin_mfa WHERE id = 'b1'`);
      return [u.rowCount, d.rowCount];
    });
    expect(res).toEqual([0, 0]);
  });

  it("WITH CHECK refuses a row tagged for another workspace", async () => {
    await expect(
      asRole(APP_ROLE, WS_A, (c) => c.query(`INSERT INTO lms_courses VALUES ('x', $1)`, [WS_B])),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asRole(APP_ROLE, WS_A, (c) => c.query(`UPDATE lms_courses SET workspace_id = $1 WHERE id = 'a1'`, [WS_B])),
    ).rejects.toThrow(/row-level security/i);
    const ok = await asRole(APP_ROLE, WS_A, async (c) => (await c.query(`INSERT INTO lms_courses VALUES ('x', $1)`, [WS_A])).rowCount);
    expect(ok).toBe(1);
  });

  it("system work (app.rls_system = 'on') reads across workspaces", async () => {
    const n = await asRole(APP_ROLE, null, async (c) => (await c.query(`SELECT id FROM ogiam_decisions`)).rowCount, true);
    expect(n).toBe(3);
  });

  it("the table OWNER is unaffected, even without BYPASSRLS (the deploy-day guarantee)", async () => {
    for (const t of ["instinct_admin_mfa", "lms_courses", "instinct_spec_diff_runs"]) {
      const n = await asRole(OWNER_ROLE, null, async (c) => (await c.query(`SELECT id FROM ${t}`)).rowCount);
      expect({ t, n }).toEqual({ t, n: 3 });
    }
  });

  it("both migrations are idempotent: a second run changes nothing", async () => {
    const before = await policyState();
    await admin.query(UP_296);
    await admin.query(UP_297);
    expect(await policyState()).toBe(before);
  });

  it("both migrations are reversible: down restores the tripwire, up lands in the same state", async () => {
    const applied = await policyState();
    await admin.query(DOWN_297);
    await admin.query(DOWN_296);
    // After down: 296 tables back on the permissive policy, 297 tables RLS off.
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT string_agg(polname, ',') FROM pg_policy p WHERE p.polrelid = c.oid) AS pols
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [SCHEMA, ["instinct_admin_mfa", "lms_courses"]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.relname, r]));
    expect(by.instinct_admin_mfa).toMatchObject({ relrowsecurity: true, pols: "instinct_admin_mfa_all" });
    expect(by.lms_courses).toMatchObject({ relrowsecurity: false, pols: null });
    // Down is itself idempotent.
    await admin.query(DOWN_297);
    await admin.query(DOWN_296);
    await admin.query(UP_296);
    await admin.query(UP_297);
    expect(await policyState()).toBe(applied);
  });

  it("db.ts query() with INSTINCT_RLS_SESSION_CONTEXT=on filters by the bound workspace", async () => {
    const u = new globalThis.URL(requireLocalTestDatabase(URL));
    u.username = APP_ROLE;
    u.password = APP_PASSWORD;
    u.searchParams.set("options", `-c search_path=${SCHEMA}`);
    const saved = { url: process.env.DATABASE_URL, flag: process.env.INSTINCT_RLS_SESSION_CONTEXT };
    process.env.DATABASE_URL = u.toString();
    process.env.INSTINCT_RLS_SESSION_CONTEXT = "on";
    try {
      let rowsA: string[] = [];
      let rowsB: string[] = [];
      let unbound = -1;
      await jest.isolateModulesAsync(async () => {
        // db.ts forces sslmode=verify-full for Neon; the CI Postgres has no TLS.
        // Pass the URL through unchanged so the REAL query() path is what runs.
        jest.doMock("@/lib/db-url", () => ({
          ...jest.requireActual("@/lib/db-url"),
          normalizeDatabaseUrlSsl: (url: string | undefined) => url,
        }));
        const db = await import("@/lib/db");
        const rw = await import("@/lib/db/request-workspace");
        rowsA = (await rw.runWithRequestWorkspace(WS_A, () => db.query(`SELECT id FROM lms_courses ORDER BY id`))).rows.map((r) => String(r.id));
        rowsB = (await rw.runWithRequestWorkspace(WS_B, () => db.query(`SELECT id FROM lms_courses ORDER BY id`))).rows.map((r) => String(r.id));
        unbound = (await db.query(`SELECT id FROM lms_courses`)).rowCount ?? -1;
        await db.pool.end();
      });
      expect(rowsA).toEqual(expect.arrayContaining(["a1", "a2"]));
      expect(rowsA).not.toContain("b1");
      expect(rowsB).toEqual(["b1"]);
      expect(unbound).toBe(0);
    } finally {
      process.env.DATABASE_URL = saved.url;
      if (saved.flag === undefined) delete process.env.INSTINCT_RLS_SESSION_CONTEXT;
      else process.env.INSTINCT_RLS_SESSION_CONTEXT = saved.flag;
    }
  });
});
