/**
 * OGIAM control-plane tenant registry, run against a REAL Postgres built from
 * the REAL migration 253. Proves the registry's SQL runs against the schema the
 * migration produces, that the connection string is stored ENCRYPTED (never
 * plaintext) and round-trips, and that the status CHECK holds.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

// secret-storage derives its key from INSTINCT_JWT_SECRET; give the test one if
// the environment has not (so encrypt/decrypt work without a real prod secret).
if (!process.env.INSTINCT_JWT_SECRET && !process.env.INSTINCT_SECRET_KEY) {
  process.env.INSTINCT_JWT_SECRET = "test-jwt-secret-at-least-32-chars-long-000";
}
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

// The registry's SQL, verbatim (src/lib/tenancy/registry.ts).
const INSERT = `
  INSERT INTO instinct_tenant_registry(tenant_id, org_name, status, admin_email, created_by)
  VALUES ($1,$2,'pending_provision',$3,$4)
  ON CONFLICT (tenant_id) DO NOTHING`;
const SET_CONN = `UPDATE instinct_tenant_registry SET db_url_encrypted = $2, status = 'active', updated_at = now() WHERE tenant_id = $1`;
const LIST = `SELECT tenant_id, org_name, status, (db_url_encrypted IS NOT NULL) AS has_db, admin_email, created_at::text AS created_at FROM instinct_tenant_registry ORDER BY created_at DESC`;
const READ_ENC = `SELECT db_url_encrypted FROM instinct_tenant_registry WHERE tenant_id = $1`;

describeIfDb("OGIAM tenant registry", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS instinct_tenant_registry CASCADE`);
    await db.query(readFileSync(join(__dirname, "..", "migrations", "253_tenant_registry.sql"), "utf8"));
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query(`TRUNCATE instinct_tenant_registry`); });

  it("registers a tenant as pending_provision and reads it back", async () => {
    await db.query(INSERT, ["t-acme-ab12", "Acme Inc", "admin@acme.com", null]);
    const { rows } = await db.query(LIST);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe("t-acme-ab12");
    expect(rows[0].status).toBe("pending_provision");
    expect(rows[0].has_db).toBe(false); // no db attached yet
  });

  it("register is idempotent on tenant_id (ON CONFLICT DO NOTHING)", async () => {
    await db.query(INSERT, ["t-acme-ab12", "Acme Inc", "a@acme.com", null]);
    await db.query(INSERT, ["t-acme-ab12", "Acme Inc RENAMED", "other@acme.com", null]);
    const { rows } = await db.query(LIST);
    expect(rows).toHaveLength(1);
    expect(rows[0].org_name).toBe("Acme Inc"); // first write wins, not overwritten
  });

  it("stores the connection string ENCRYPTED (never plaintext) and round-trips", async () => {
    const conn = "postgres://user:pass@ep-tenant-xyz.neon.tech/neondb";
    await db.query(INSERT, ["t-acme-ab12", "Acme Inc", "a@acme.com", null]);
    await db.query(SET_CONN, ["t-acme-ab12", encryptSecret(conn)]);

    const enc = (await db.query(READ_ENC, ["t-acme-ab12"])).rows[0].db_url_encrypted as string;
    expect(enc).not.toContain("postgres://"); // never plaintext at rest
    expect(enc).not.toContain("pass");
    expect(decryptSecret(enc)).toBe(conn); // and it round-trips server-side

    const listed = (await db.query(LIST)).rows[0];
    expect(listed.status).toBe("active");
    expect(listed.has_db).toBe(true);
    // The listing shape never includes the encrypted column.
    expect(Object.keys(listed)).not.toContain("db_url_encrypted");
  });

  it("rejects an out-of-domain status via the CHECK constraint", async () => {
    await expect(
      db.query(`INSERT INTO instinct_tenant_registry(tenant_id, org_name, status) VALUES ('t-x-0000','X','bogus')`),
    ).rejects.toThrow();
  });
});
