/**
 * Sealing backfill (src/lib/crypto/at-rest-seal-backfill.ts, driven by
 * scripts/seal-at-rest-secrets.ts) against a REAL Postgres, for the
 * QuickBooks token and delegation issuer secret targets. Proves:
 *   - a dry run counts and writes nothing;
 *   - --apply seals every unsealed row, the sealed values open to the original
 *     tokens, already-sealed rows and updated_at are untouched;
 *   - a re-run is a no-op (byte-identical rows) and reports already_sealed;
 *   - a row this key cannot open is counted as failed and never written;
 *   - the key check refuses a key that does not open the app's sealed values,
 *     and a primary key the deployed app is not proven to use.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { encryptSecret, decryptSecretWithInfo, secretKeyId, __resetSecretKeyCacheForTests, setSecretKeySignalSink } from "@/lib/crypto/secret-storage";
import { SEAL_TARGETS, sealAtRest } from "@/lib/crypto/at-rest-seal-backfill";

const sealQboTokens = (db: Client, opts: { apply: boolean }) => sealAtRest(db, SEAL_TARGETS.qbo_tokens, opts);

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const KEY_PRIMARY = "3".repeat(64);
const KEY_OTHER = "4".repeat(64);
const PRIMARY_KID = secretKeyId(Buffer.from(KEY_PRIMARY, "hex"));
const SAVED = { ...process.env };
const TABLES = ["instinct_qbo_tokens", "instinct_ms_tokens", "instinct_delegation_issuers", "instinct_events"];
const MIGRATIONS = ["261_delegation_issuers.sql", "265_delegation_issuer_asymmetric.sql"];

function setKeys(vars: Record<string, string | undefined>): void {
  for (const k of ["INSTINCT_SECRET_KEY", "INSTINCT_SECRET_KEY_PREVIOUS", "INSTINCT_JWT_SECRET"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  __resetSecretKeyCacheForTests();
}
const primaryMode = () => setKeys({ INSTINCT_SECRET_KEY: KEY_PRIMARY });

describeIfDb("at-rest sealing backfill", () => {
  let db: Client;

  beforeAll(async () => {
    setSecretKeySignalSink(() => {});
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    /* Same shape as migrations 004 + 042 + 047. */
    await db.query(`
      CREATE TABLE instinct_qbo_tokens (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        realm_id      TEXT NOT NULL,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        company_name  TEXT,
        connected_by  TEXT NOT NULL,
        connected_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT instinct_qbo_tokens_realm_id_unique UNIQUE (realm_id)
      )`);
    await db.query(`
      CREATE TABLE instinct_ms_tokens (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_email TEXT NOT NULL,
        access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        connected_by TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    for (const m of MIGRATIONS) await db.query(readFileSync(join(__dirname, "..", "migrations", m), "utf8"));
    await db.query(`CREATE TABLE instinct_events (id BIGSERIAL PRIMARY KEY, event_type TEXT, user_id TEXT, user_role TEXT, metadata JSONB, timestamp TIMESTAMPTZ)`);
  });

  afterAll(async () => {
    if (db) for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await db?.end();
    process.env = SAVED;
    setSecretKeySignalSink(null);
    __resetSecretKeyCacheForTests();
  });

  beforeEach(async () => {
    for (const t of TABLES) await db.query(`TRUNCATE ${t}`);
  });

  async function seedQbo(realm: string, access: string, refresh: string): Promise<void> {
    await db.query(
      `INSERT INTO instinct_qbo_tokens (realm_id, access_token, refresh_token, expires_at, connected_by, updated_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', 'u-1', '2026-01-01T00:00:00Z')`,
      [realm, access, refresh],
    );
  }

  /** Two rows not sealed yet plus one the app already sealed under the primary. */
  async function seedRollout(): Promise<void> {
    primaryMode();
    await seedQbo("realm-plain-1", "eyJ.plain-access-1", "AB11plain-refresh-1");
    await seedQbo("realm-plain-2", "eyJ.plain-access-2", "AB11plain-refresh-2");
    await seedQbo("realm-sealed", encryptSecret("eyJ.sealed-access"), encryptSecret("AB11sealed-refresh"));
  }

  async function snapshot(): Promise<string> {
    return JSON.stringify((await db.query(`SELECT realm_id, access_token, refresh_token, updated_at FROM instinct_qbo_tokens ORDER BY realm_id`)).rows);
  }

  it("a dry run counts and writes nothing", async () => {
    await seedRollout();
    const before = await snapshot();
    const r = await sealQboTokens(db, { apply: false });
    expect(r).toMatchObject({ present: true, applied: false, rows: 3, alreadySealed: 1, toSeal: 2, sealed: 0, failed: 0 });
    expect(r.key).toMatchObject({ ok: true, appKey: "stored_value" });
    expect(await snapshot()).toBe(before);
  });

  it("--apply seals every unsealed row; the values open; sealed rows and updated_at are untouched", async () => {
    await seedRollout();
    const sealedBefore = (await db.query(`SELECT access_token, refresh_token FROM instinct_qbo_tokens WHERE realm_id = 'realm-sealed'`)).rows[0];

    const r = await sealQboTokens(db, { apply: true });
    expect(r).toMatchObject({ applied: true, rows: 3, alreadySealed: 1, toSeal: 2, sealed: 2, failed: 0 });

    const rows = (await db.query(`SELECT realm_id, access_token, refresh_token, updated_at FROM instinct_qbo_tokens ORDER BY realm_id`)).rows;
    for (const row of rows) {
      expect(row.access_token.startsWith(`v1.${PRIMARY_KID}.`)).toBe(true);
      expect(row.refresh_token.startsWith(`v1.${PRIMARY_KID}.`)).toBe(true);
      expect(new Date(row.updated_at).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    }
    const byRealm = Object.fromEntries(rows.map((x) => [x.realm_id, x]));
    expect(decryptSecretWithInfo(byRealm["realm-plain-1"].access_token)).toMatchObject({ ok: true, value: "eyJ.plain-access-1", keyClass: "primary" });
    expect(decryptSecretWithInfo(byRealm["realm-plain-2"].refresh_token)).toMatchObject({ ok: true, value: "AB11plain-refresh-2" });
    expect({ access_token: byRealm["realm-sealed"].access_token, refresh_token: byRealm["realm-sealed"].refresh_token }).toEqual(sealedBefore);

    const events = (await db.query(`SELECT metadata FROM instinct_events WHERE event_type = 'security.qbo_token_encrypted' ORDER BY metadata->>'realm_id'`)).rows;
    expect(events.map((e) => e.metadata)).toEqual([
      { realm_id: "realm-plain-1", source: "operator_script" },
      { realm_id: "realm-plain-2", source: "operator_script" },
    ]);
    // No token value in any recorded event.
    expect(JSON.stringify(events)).not.toMatch(/plain-access|plain-refresh/);
  });

  it("a re-run is a no-op and reports every row as already sealed", async () => {
    await seedRollout();
    await sealQboTokens(db, { apply: true });
    const before = await snapshot();
    const again = await sealQboTokens(db, { apply: true });
    expect(again).toMatchObject({ rows: 3, alreadySealed: 3, toSeal: 0, sealed: 0, failed: 0 });
    expect(await snapshot()).toBe(before);
  });

  it("a row this key cannot open is counted as failed and left untouched", async () => {
    setKeys({ INSTINCT_SECRET_KEY: KEY_OTHER });
    const foreign = encryptSecret("eyJ.foreign");
    await seedRollout(); // switches to the primary
    await seedQbo("realm-foreign", foreign, "AB11plain-r");
    /* A sealed value this key cannot open also fails the key check, so the
       whole run is refused: nothing is written, and the row is reported. */
    const r = await sealQboTokens(db, { apply: true });
    expect(r.key).toEqual({ ok: false, reason: "key_mismatch" });
    expect(r).toMatchObject({ applied: false, sealed: 0, unreadable: 1, failed: 1 });
    expect((await db.query(`SELECT access_token FROM instinct_qbo_tokens WHERE realm_id = 'realm-foreign'`)).rows[0].access_token).toBe(foreign);
    expect((await db.query(`SELECT access_token FROM instinct_qbo_tokens WHERE realm_id = 'realm-plain-1'`)).rows[0].access_token).toBe("eyJ.plain-access-1");
  });

  it("refuses a key that does not open the app's sealed values (no write)", async () => {
    setKeys({ INSTINCT_SECRET_KEY: KEY_OTHER });
    await db.query(
      `INSERT INTO instinct_ms_tokens (user_email, access_token, refresh_token, expires_at, connected_by) VALUES ('a@example.test', $1, $2, NOW(), 'u-a')`,
      [encryptSecret("eyJ.graph"), encryptSecret("0.A.graph")],
    );
    primaryMode();
    await seedQbo("realm-plain-1", "eyJ.plain-access-1", "AB11plain-refresh-1");
    const before = await snapshot();
    const r = await sealQboTokens(db, { apply: true });
    expect(r.key).toEqual({ ok: false, reason: "key_mismatch" });
    expect(r).toMatchObject({ applied: false, toSeal: 1, sealed: 0 });
    expect(await snapshot()).toBe(before);
  });

  it("refuses a primary key the deployed app is not proven to use, then accepts the app's own report", async () => {
    setKeys({}); // the app has written under the legacy key only
    await db.query(
      `INSERT INTO instinct_ms_tokens (user_email, access_token, refresh_token, expires_at, connected_by) VALUES ('a@example.test', $1, $2, NOW(), 'u-a')`,
      [encryptSecret("eyJ.graph"), encryptSecret("0.A.graph")],
    );
    await seedQbo("realm-plain-1", "eyJ.plain-access-1", "AB11plain-refresh-1");
    primaryMode();
    const before = await snapshot();
    const refused = await sealQboTokens(db, { apply: true });
    expect(refused.key).toEqual({ ok: false, reason: "app_key_not_observed" });
    expect(refused.sealed).toBe(0);
    expect(await snapshot()).toBe(before);

    await db.query(`INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ('security.secret_key_primary_active', 'system', 'system', $1, NOW())`, [
      JSON.stringify({ primary_kid: PRIMARY_KID }),
    ]);
    const ok = await sealQboTokens(db, { apply: true });
    expect(ok.key).toMatchObject({ ok: true, appKey: "app_event" });
    expect(ok).toMatchObject({ sealed: 1, failed: 0 });
  });

  it("a shell without a primary key seals under the legacy key once the legacy key is proven", async () => {
    setKeys({ INSTINCT_JWT_SECRET: "j".repeat(40) });
    await seedQbo("realm-sealed", encryptSecret("eyJ.sealed-access"), encryptSecret("AB11sealed-refresh"));
    await seedQbo("realm-plain-1", "eyJ.plain-access-1", "AB11plain-refresh-1");
    const r = await sealQboTokens(db, { apply: true });
    expect(r.key).toMatchObject({ ok: true, appKey: "no_primary_in_shell" });
    expect(r).toMatchObject({ sealed: 1, alreadySealed: 1 });
    const v = (await db.query(`SELECT access_token FROM instinct_qbo_tokens WHERE realm_id = 'realm-plain-1'`)).rows[0].access_token;
    expect(decryptSecretWithInfo(v)).toMatchObject({ ok: true, value: "eyJ.plain-access-1", keyClass: "legacy" });
  });

  it("reports an absent table instead of failing", async () => {
    await db.query(`ALTER TABLE instinct_qbo_tokens RENAME TO instinct_qbo_tokens_hidden`);
    try {
      await expect(sealQboTokens(db, { apply: false })).resolves.toMatchObject({ present: false, rows: 0 });
    } finally {
      await db.query(`ALTER TABLE instinct_qbo_tokens_hidden RENAME TO instinct_qbo_tokens`);
    }
  });

  describe("delegation issuer secrets", () => {
    async function seedIssuer(ws: string, issuer: string, secret: string | null, algorithm = "hs256"): Promise<void> {
      await db.query(
        `INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret, public_key) VALUES ($1, $2, $3, $4, $5)`,
        [ws, issuer, algorithm, secret, secret === null ? JSON.stringify({ kty: "EC" }) : null],
      );
    }
    const issuers = async () =>
      (await db.query(`SELECT workspace_id, issuer, secret FROM instinct_delegation_issuers ORDER BY workspace_id, issuer`)).rows;

    it("seals every unsealed secret, skips es256 issuers, records an event per row, and a re-run is a no-op", async () => {
      primaryMode();
      await seedIssuer("w1", "acme", "shared-secret-value-one");
      await seedIssuer("w2", "acme", encryptSecret("shared-secret-value-two"));
      await seedIssuer("w1", "asym", null, "es256");

      const dry = await sealAtRest(db, SEAL_TARGETS.delegation_issuers, { apply: false });
      expect(dry).toMatchObject({ rows: 3, alreadySealed: 1, empty: 1, toSeal: 1, sealed: 0, failed: 0 });
      expect((await issuers())[0].secret).toBe("shared-secret-value-one");

      const r = await sealAtRest(db, SEAL_TARGETS.delegation_issuers, { apply: true });
      expect(r).toMatchObject({ applied: true, rows: 3, alreadySealed: 1, empty: 1, toSeal: 1, sealed: 1, failed: 0 });
      const rows = await issuers();
      expect(rows[0].secret.startsWith(`v1.${PRIMARY_KID}.`)).toBe(true);
      expect(decryptSecretWithInfo(rows[0].secret)).toMatchObject({ ok: true, value: "shared-secret-value-one", keyClass: "primary" });
      expect(rows[1].secret).toBeNull(); // es256: nothing to seal
      const events = (await db.query(`SELECT metadata FROM instinct_events WHERE event_type = 'security.delegation_secret_encrypted'`)).rows;
      expect(events.map((e) => e.metadata)).toEqual([{ workspace_id: "w1", issuer: "acme", source: "operator_script" }]);
      expect(JSON.stringify(events)).not.toContain("shared-secret-value");

      const before = JSON.stringify(await issuers());
      const again = await sealAtRest(db, SEAL_TARGETS.delegation_issuers, { apply: true });
      expect(again).toMatchObject({ alreadySealed: 2, empty: 1, toSeal: 0, sealed: 0 });
      expect(JSON.stringify(await issuers())).toBe(before);
    });
  });
});
