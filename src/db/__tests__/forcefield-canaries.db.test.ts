/**
 * Forcefield canary registry, run against a REAL Postgres built from the REAL
 * migration 251. Proves the store's SQL runs against the schema the migration
 * produces (columns exist, the kind CHECK fires, the active flag filters).
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

// The store's SQL, verbatim (src/lib/forcefield/canary-store.ts).
const INSERT = `
  INSERT INTO instinct_forcefield_canaries (workspace_id, kind, value, seeded_in, created_by)
  VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at::text AS created_at`;
const MATCHING = `
  SELECT id, kind, value, seeded_in FROM instinct_forcefield_canaries
   WHERE workspace_id = $1 AND active = true`;
const DEACTIVATE = `UPDATE instinct_forcefield_canaries SET active = false WHERE workspace_id = $1 AND id = $2`;

describeIfDb("Forcefield canary registry", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_forcefield_canaries CASCADE`);
    await db.query(readFileSync(join(__dirname, "..", "migrations", "251_forcefield_canaries.sql"), "utf8"));
  });

  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_forcefield_canaries`); });

  it("inserts a decoy and the matching query reads it back", async () => {
    const ins = await db.query(INSERT, ["w1", "token", "sk-decoy-1", "customers", "u1"]);
    expect(ins.rows).toHaveLength(1);
    const m = await db.query(MATCHING, ["w1"]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].value).toBe("sk-decoy-1");
    expect(m.rows[0].seeded_in).toBe("customers");
  });

  it("is workspace-isolated", async () => {
    await db.query(INSERT, ["w1", "route", "/admin/export-all", "decoy route", "u1"]);
    expect((await db.query(MATCHING, ["w2"])).rows).toHaveLength(0);
  });

  it("a deactivated decoy no longer matches", async () => {
    const ins = await db.query(INSERT, ["w1", "tool", "export_all", "manifest", "u1"]);
    await db.query(DEACTIVATE, ["w1", ins.rows[0].id]);
    expect((await db.query(MATCHING, ["w1"])).rows).toHaveLength(0);
  });

  it("the CHECK constraint rejects an unknown decoy kind", async () => {
    await expect(
      db.query(INSERT, ["w1", "malware", "x", "y", "u1"]),
    ).rejects.toThrow(/instinct_forcefield_canaries_kind_chk|check constraint/i);
  });
});
