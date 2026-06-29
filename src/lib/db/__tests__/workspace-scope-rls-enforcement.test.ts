/**
 * RLS ENFORCEMENT PROOF (real database; skipped without DATABASE_URL).
 *
 * This is the validation harness for the session-var RLS retrofit. It proves, on
 * a real Postgres, that the exact policy shape the rollout uses — FORCE ROW LEVEL
 * SECURITY + a policy keyed on current_setting('app.workspace_id', true) — when
 * driven through withWorkspaceScope(), genuinely isolates tenants:
 *
 *   1. inside a workspace scope a SELECT returns ONLY that workspace's rows;
 *   2. UNSCOPED (no GUC) the table is fail-closed: zero rows (NULL != workspace_id);
 *   3. a cross-workspace UPDATE affects zero rows (the other tenant is invisible);
 *   4. WITH CHECK blocks writing a row tagged for a different workspace.
 *
 * No mock pg here: it runs against the real pool. It is GATED on DATABASE_URL so
 * the default CI/local jest run skips it; point it at a throwaway/test database
 * (DATABASE_URL=... npx jest workspace-scope-rls-enforcement) to validate the
 * policy SQL BEFORE any production FORCE-RLS migration is flipped. The table is a
 * self-contained probe, created + dropped here; it touches no app tables.
 */
import { query, withWorkspaceScope } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const onDb = HAS_DB ? describe : describe.skip;

const TABLE = "_wsrls_probe";

async function setup(): Promise<void> {
  await query(`DROP TABLE IF EXISTS ${TABLE}`);
  await query(
    `CREATE TABLE ${TABLE} (
       id           TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL,
       label        TEXT
     )`,
  );
  await query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  // FORCE: without this the table OWNER (the app's connection role) BYPASSES RLS
  // and the policy is a no-op — the silent way to ship fake "enforcement".
  await query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
  await query(
    `CREATE POLICY ${TABLE}_iso ON ${TABLE}
       FOR ALL
       USING (workspace_id = current_setting('app.workspace_id', true))
       WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  );
  // Seed inside each workspace's own scope (WITH CHECK requires the GUC to match).
  await withWorkspaceScope("ws-A", async () => {
    await query(`INSERT INTO ${TABLE} (id, workspace_id, label) VALUES ('a1','ws-A','A one')`);
    await query(`INSERT INTO ${TABLE} (id, workspace_id, label) VALUES ('a2','ws-A','A two')`);
  });
  await withWorkspaceScope("ws-B", async () => {
    await query(`INSERT INTO ${TABLE} (id, workspace_id, label) VALUES ('b1','ws-B','B one')`);
  });
}

onDb("withWorkspaceScope enforces FORCE-RLS isolation on a real DB", () => {
  beforeAll(setup);
  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS ${TABLE}`);
  });

  test("a scoped SELECT returns only the caller's workspace rows", async () => {
    const a = await withWorkspaceScope("ws-A", () => query(`SELECT id FROM ${TABLE} ORDER BY id`));
    expect(a.rows.map((r) => r.id)).toEqual(["a1", "a2"]);
    const b = await withWorkspaceScope("ws-B", () => query(`SELECT id FROM ${TABLE} ORDER BY id`));
    expect(b.rows.map((r) => r.id)).toEqual(["b1"]);
  });

  test("UNSCOPED the table is fail-closed: zero rows (GUC unset)", async () => {
    const res = await query(`SELECT id FROM ${TABLE}`);
    expect(res.rows).toEqual([]);
  });

  test("a cross-workspace UPDATE affects zero rows (other tenant invisible)", async () => {
    const res = await withWorkspaceScope("ws-A", () =>
      query(`UPDATE ${TABLE} SET label = 'hacked' WHERE id = 'b1'`),
    );
    expect(res.rowCount).toBe(0);
    // And b1 is untouched, confirmed from ws-B.
    const b = await withWorkspaceScope("ws-B", () => query(`SELECT label FROM ${TABLE} WHERE id = 'b1'`));
    expect(b.rows[0]?.label).toBe("B one");
  });

  test("WITH CHECK blocks writing a row tagged for a different workspace", async () => {
    await expect(
      withWorkspaceScope("ws-A", () =>
        query(`INSERT INTO ${TABLE} (id, workspace_id, label) VALUES ('x','ws-B','sneaky')`),
      ),
    ).rejects.toThrow();
  });
});
