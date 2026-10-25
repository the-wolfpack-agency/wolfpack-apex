/**
 * RLS cutover prerequisites (docs/security/rls-cutover.md), on a REAL Postgres,
 * through the REAL db.ts and the real wrapped stores, connected as a role
 * WITHOUT BYPASSRLS that does not own the tables: the shape production will
 * have after the cutover.
 *
 * Flag ON (INSTINCT_RLS_SESSION_CONTEXT=on):
 *   - a cron's wrapped work list (dueSchedules, listAllEnabledWatched) still
 *     sees every workspace, while the same statement unwrapped sees nothing;
 *   - a sweep's per-workspace write lands under its own workspace only;
 *   - a request-scoped query sees only its workspace, including right after a
 *     nested withSystemScope returns;
 *   - withTransaction runs under the same context: own workspace only, system
 *     sees all, no context sees nothing, WITH CHECK refuses a foreign row, and
 *     a refused write rolls the whole block back.
 * Flag OFF: no setting reaches the database at all (the same as before these
 * changes), and as the table owner (production today) the wrapped stores read
 * exactly what an unwrapped query reads.
 *
 * Builds a private schema with stand-ins for every table 296/297 name (real
 * columns where a store reads them), applies the real 296/297, and refuses a
 * non-local host. Skipped unless TEST_DATABASE_URL is set.
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, "..", "migrations");
const UP_296 = readFileSync(join(MIGRATIONS, "296_rls_workspace_policies.sql"), "utf8");
const UP_297 = readFileSync(join(MIGRATIONS, "297_rls_workspace_policies_remaining.sql"), "utf8");
const tablesOf = (sql: string) => [...new Set([...sql.matchAll(/^ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY;/gm)].map((m) => m[1]))];
const COVERED = [...new Set([...tablesOf(UP_296), ...tablesOf(UP_297)])];
const UUID_TABLES = new Set(["instinct_spec_diff_runs"]);

/** Real columns for the tables the stores under test read. */
const REAL_SHAPE: Record<string, string> = {
  assistant_routine_schedules: `id text PRIMARY KEY, workspace_id text, user_id text, command text, cadence text,
    hour int, weekday int, time_zone text, next_run_at timestamptz, failures int DEFAULT 0, active boolean DEFAULT true,
    last_run_at timestamptz`,
  instinct_ai_code_watched_repos: `id text PRIMARY KEY, workspace_id text, repo text, enabled boolean DEFAULT true`,
};

const SUFFIX = `${process.pid}`;
const SCHEMA = `rls_prereq_${SUFFIX}`;
const APP_ROLE = `rls_prereq_app_${SUFFIX}`;
const OWNER_ROLE = `rls_prereq_owner_${SUFFIX}`;
const APP_PASSWORD = `pw_${SUFFIX}_prereq`;
const WS_A = "ws-a";
const WS_B = "ws-b";

type Db = typeof import("@/lib/db");
type Rw = typeof import("@/lib/db/request-workspace");

describeIfDb("RLS cutover prerequisites against a real Postgres", () => {
  let admin: Client;

  function urlFor(role: "app" | "admin"): string {
    const u = new globalThis.URL(requireLocalTestDatabase(URL));
    if (role === "app") {
      u.username = APP_ROLE;
      u.password = APP_PASSWORD;
    }
    u.searchParams.set("options", `-c search_path=${SCHEMA}`);
    return u.toString();
  }

  /** Load the real db.ts (and the stores) against `url` with the flag set,
   *  run fn, then tear the pool down so the next load gets a fresh one. */
  async function withApp<T>(
    url: string,
    flag: "on" | "off",
    fn: (m: { db: Db; rw: Rw; schedules: typeof import("@/lib/assistant/routines/schedule-store"); watched: typeof import("@/lib/ai-code/watched-repos") }) => Promise<T>,
  ): Promise<T> {
    const saved = { url: process.env.DATABASE_URL, flag: process.env.INSTINCT_RLS_SESSION_CONTEXT };
    process.env.DATABASE_URL = url;
    process.env.INSTINCT_RLS_SESSION_CONTEXT = flag;
    let out: T | undefined;
    try {
      await jest.isolateModulesAsync(async () => {
        // The CI Postgres has no TLS; pass the URL through so the real query() path runs.
        jest.doMock("@/lib/db-url", () => ({
          ...jest.requireActual("@/lib/db-url"),
          normalizeDatabaseUrlSsl: (u: string | undefined) => u,
        }));
        jest.doMock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn() }));
        const g = globalThis as unknown as { __pgPool?: { end(): Promise<void> } };
        delete g.__pgPool;
        const db = await import("@/lib/db");
        const rw = await import("@/lib/db/request-workspace");
        const schedules = await import("@/lib/assistant/routines/schedule-store");
        const watched = await import("@/lib/ai-code/watched-repos");
        try {
          out = await fn({ db, rw, schedules, watched });
        } finally {
          await db.pool.end();
          delete g.__pgPool;
        }
      });
    } finally {
      process.env.DATABASE_URL = saved.url;
      if (saved.flag === undefined) delete process.env.INSTINCT_RLS_SESSION_CONTEXT;
      else process.env.INSTINCT_RLS_SESSION_CONTEXT = saved.flag;
    }
    return out as T;
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
    for (const t of COVERED) {
      const shape = REAL_SHAPE[t] ?? `id text PRIMARY KEY, workspace_id ${UUID_TABLES.has(t) ? "uuid" : "text"}`;
      await admin.query(`CREATE TABLE ${t} (${shape})`);
      await admin.query(`ALTER TABLE ${t} OWNER TO ${OWNER_ROLE}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE}`);
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE}, ${OWNER_ROLE}`);
    await admin.query(`INSERT INTO lms_courses VALUES ('a1', $1), ('a2', $1), ('b1', $2)`, [WS_A, WS_B]);
    await admin.query(
      `INSERT INTO assistant_routine_schedules (id, workspace_id, user_id, command, cadence, hour, time_zone, next_run_at)
       VALUES ('sa', $1, 'u-a', 'brief', 'daily', 7, 'UTC', now() - interval '1 hour'),
              ('sb', $2, 'u-b', 'brief', 'daily', 7, 'UTC', now() - interval '1 hour')`,
      [WS_A, WS_B],
    );
    await admin.query(
      `INSERT INTO instinct_ai_code_watched_repos (id, workspace_id, repo) VALUES ('wa', $1, 'o/a'), ('wb', $2, 'o/b')`,
      [WS_A, WS_B],
    );
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

  describe("flag ON, non-owner role", () => {
    it("a wrapped cron work list still sees every workspace; unwrapped it sees none", async () => {
      const got = await withApp(urlFor("app"), "on", async ({ db, schedules, watched }) => ({
        due: (await schedules.dueSchedules(new Date())).map((r) => r.workspaceId).sort(),
        repos: (await watched.listAllEnabledWatched()).map((r) => r.workspaceId).sort(),
        unwrapped: (await db.query(`SELECT id FROM assistant_routine_schedules`)).rowCount,
      }));
      expect(got.due).toEqual([WS_A, WS_B]);
      expect(got.repos).toEqual([WS_A, WS_B]);
      expect(got.unwrapped).toBe(0);
    });

    it("a sweep's per-workspace write lands under its own workspace only", async () => {
      await withApp(urlFor("app"), "on", async ({ rw, schedules }) => {
        const rows = await schedules.dueSchedules(new Date());
        const a = rows.find((r) => r.id === "sa")!;
        const b = rows.find((r) => r.id === "sb")!;
        const now = new Date();
        await rw.runWithRequestWorkspace(WS_A, () => schedules.recordRun(a, "ok", now));
        // The wrong workspace cannot touch B's row: RLS hides it, 0 rows updated.
        await rw.runWithRequestWorkspace(WS_A, () => schedules.recordRun(b, "ok", now));
      });
      const { rows } = await admin.query(`SELECT id, last_run_at IS NOT NULL AS ran FROM assistant_routine_schedules ORDER BY id`);
      expect(rows).toEqual([
        { id: "sa", ran: true },
        { id: "sb", ran: false },
      ]);
    });

    it("a request-scoped query sees only its workspace, also right after a nested system read", async () => {
      const got = await withApp(urlFor("app"), "on", async ({ db, rw }) =>
        rw.runWithRequestWorkspace(WS_A, async () => {
          const before = (await db.query(`SELECT id FROM lms_courses ORDER BY id`)).rows.map((r) => String(r.id));
          const system = (await rw.withSystemScope(() => db.query(`SELECT id FROM lms_courses`))).rowCount;
          const after = (await db.query(`SELECT id FROM lms_courses ORDER BY id`)).rows.map((r) => String(r.id));
          const other = (await rw.runWithRequestWorkspace(WS_B, () => db.query(`SELECT id FROM lms_courses`))).rows.map((r) => String(r.id));
          return { before, system, after, other };
        }),
      );
      expect(got.before).toEqual(["a1", "a2"]);
      expect(got.system).toBe(3);
      expect(got.after).toEqual(["a1", "a2"]);
      expect(got.other).toEqual(["b1"]);
    });

    it("withTransaction respects the context", async () => {
      const got = await withApp(urlFor("app"), "on", async ({ db, rw }) => {
        const count = () => db.withTransaction(async (tx) => Number((await tx.write<{ n: string }>(`SELECT count(*)::int AS n FROM lms_courses`)).rows[0].n));
        const own = await rw.runWithRequestWorkspace(WS_A, count);
        const system = await rw.withSystemScope(count);
        const none = await count();
        const foreign = await rw
          .runWithRequestWorkspace(WS_A, () => db.withTransaction((tx) => tx.write(`INSERT INTO lms_courses VALUES ('x-b', $1)`, [WS_B])))
          .then(() => "inserted", (e: Error) => e.message);
        const atomic = await rw
          .runWithRequestWorkspace(WS_A, () =>
            db.withTransaction(async (tx) => {
              await tx.write(`INSERT INTO lms_courses VALUES ('a3', $1)`, [WS_A]);
              await tx.write(`INSERT INTO lms_courses VALUES ('x-b2', $1)`, [WS_B]);
            }),
          )
          .then(() => "committed", () => "rolled back");
        const ok = await rw.runWithRequestWorkspace(WS_A, () =>
          db.withTransaction(async (tx) => (await tx.write(`INSERT INTO lms_courses VALUES ('a4', $1) RETURNING id`, [WS_A])).rows.length),
        );
        return { own, system, none, foreign, atomic, ok };
      });
      expect(got.own).toBe(2);
      expect(got.system).toBe(3);
      expect(got.none).toBe(0);
      expect(got.foreign).toMatch(/row-level security/);
      expect(got.atomic).toBe("rolled back");
      expect(got.ok).toBe(1);
      const { rows } = await admin.query(`SELECT id FROM lms_courses ORDER BY id`);
      expect(rows.map((r) => r.id)).toEqual(["a1", "a2", "a4", "b1"]);
      await admin.query(`DELETE FROM lms_courses WHERE id = 'a4'`);
    });
  });

  describe("flag OFF", () => {
    const SETTINGS = `SELECT current_setting('app.workspace_id', true) AS w, current_setting('app.rls_system', true) AS s`;
    const unset = (r: { w: string | null; s: string | null }) => !r.w && !r.s;

    it("no setting reaches the database from any wrapper or from withTransaction", async () => {
      const got = await withApp(urlFor("app"), "off", async ({ db, rw }) => {
        const rows = [
          (await db.query<{ w: string | null; s: string | null }>(SETTINGS)).rows[0],
          (await rw.withSystemScope(() => db.query<{ w: string | null; s: string | null }>(SETTINGS))).rows[0],
          (await rw.runWithRequestWorkspace(WS_A, () => db.query<{ w: string | null; s: string | null }>(SETTINGS))).rows[0],
          await rw.withSystemScope(() => db.withTransaction(async (tx) => (await tx.write<{ w: string | null; s: string | null }>(SETTINGS)).rows[0])),
          await rw.runWithRequestWorkspace(WS_A, () => db.withTransaction(async (tx) => (await tx.write<{ w: string | null; s: string | null }>(SETTINGS)).rows[0])),
        ];
        return rows.map(unset);
      });
      expect(got).toEqual([true, true, true, true, true]);
    });

    it("as the app role with the flag off, wrapped stores read nothing (exactly what unwrapped code reads)", async () => {
      const got = await withApp(urlFor("app"), "off", async ({ db, schedules }) => ({
        wrapped: (await schedules.dueSchedules(new Date())).length,
        raw: (await db.query(`SELECT id FROM assistant_routine_schedules`)).rowCount,
      }));
      expect(got).toEqual({ wrapped: 0, raw: 0 });
    });

    it("as the owner (production today) the wrapped stores read what an unwrapped query reads", async () => {
      const got = await withApp(urlFor("admin"), "off", async ({ db, schedules, watched }) => ({
        due: (await schedules.dueSchedules(new Date())).length,
        rawDue: (await db.query(`SELECT id FROM assistant_routine_schedules WHERE active AND next_run_at <= now()`)).rowCount,
        repos: (await watched.listAllEnabledWatched()).length,
        rawRepos: (await db.query(`SELECT id FROM instinct_ai_code_watched_repos WHERE enabled`)).rowCount,
      }));
      expect(got.due).toBe(got.rawDue);
      expect(got.due).toBeGreaterThan(0);
      expect(got).toMatchObject({ repos: 2, rawRepos: 2 });
    });
  });
});
