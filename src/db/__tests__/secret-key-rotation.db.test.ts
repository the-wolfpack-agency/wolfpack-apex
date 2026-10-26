/**
 * At-rest key rotation backfill (src/lib/crypto/secret-key-rotation.ts, driven
 * by scripts/rotate-secret-key.ts), run against a REAL Postgres built from the
 * REAL migrations for every encrypted column. Proves:
 *   - legacy- and previous-key values rotate to the primary and still open;
 *   - a re-run is a no-op (byte-identical rows);
 *   - a crash mid-run keeps committed batches and a re-run finishes the rest;
 *   - plaintext and unreadable values are counted and never written;
 *   - --apply's app-key proof refuses a key the app is not using.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import {
  encryptSecret,
  decryptSecret,
  decryptSecretWithInfo,
  secretKeyId,
  __resetSecretKeyCacheForTests,
  setSecretKeySignalSink,
  allowLegacyKeyForRotation,
} from "@/lib/crypto/secret-storage";
import { ROTATION_TARGETS, proveAppKey, rotateSecrets, surveySecrets, totals } from "@/lib/crypto/secret-key-rotation";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const KEY_PRIMARY = "1".repeat(64);
const KEY_PREVIOUS = "2".repeat(64);
const PRIMARY_KID = secretKeyId(Buffer.from(KEY_PRIMARY, "hex"));
const SAVED = { ...process.env };

function setKeys(vars: Record<string, string | undefined>): void {
  for (const k of ["INSTINCT_SECRET_KEY", "INSTINCT_SECRET_KEY_PREVIOUS", "INSTINCT_JWT_SECRET"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  __resetSecretKeyCacheForTests();
}
const legacyMode = () => setKeys({});
const previousMode = () => setKeys({ INSTINCT_SECRET_KEY: KEY_PREVIOUS });
const primaryMode = () => setKeys({ INSTINCT_SECRET_KEY: KEY_PRIMARY, INSTINCT_SECRET_KEY_PREVIOUS: KEY_PREVIOUS });

const MIGRATIONS = ["136_connector_credentials.sql", "138_connector_oauth.sql", "216_admin_mfa.sql", "250_workspace_model_keys.sql", "253_tenant_registry.sql", "261_delegation_issuers.sql", "265_delegation_issuer_asymmetric.sql"];

describeIfDb("at-rest key rotation backfill", () => {
  let db: Client;

  beforeAll(async () => {
    setSecretKeySignalSink(() => {});
    allowLegacyKeyForRotation(); // as scripts/rotate-secret-key.ts does
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    for (const t of ROTATION_TARGETS) await db.query(`DROP TABLE IF EXISTS ${t.table} CASCADE`);
    await db.query(`DROP TABLE IF EXISTS instinct_events CASCADE`);
    for (const m of MIGRATIONS) await db.query(readFileSync(join(__dirname, "..", "migrations", m), "utf8"));
    /* Same shape as ms-tokens-columns.db.test.ts (migrations 005 + 044). */
    await db.query(`
      CREATE TABLE instinct_ms_tokens (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_email    TEXT NOT NULL,
        display_name  TEXT,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        connected_by  TEXT NOT NULL,
        connected_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )`);
    /* Same shape as migrations 004 + 042 + 047 (QuickBooks tokens). */
    await db.query(`
      CREATE TABLE instinct_qbo_tokens (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        realm_id      TEXT NOT NULL UNIQUE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        company_name  TEXT,
        connected_by  TEXT NOT NULL,
        connected_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.query(`CREATE TABLE instinct_events (id BIGSERIAL PRIMARY KEY, event_type TEXT, user_id TEXT, user_role TEXT, metadata JSONB, timestamp TIMESTAMPTZ)`);
  });

  afterAll(async () => {
    /* Leave nothing behind for the suites that run after this one in band. */
    if (db) {
      for (const t of ROTATION_TARGETS) await db.query(`DROP TABLE IF EXISTS ${t.table} CASCADE`);
      await db.query(`DROP TABLE IF EXISTS instinct_events CASCADE`);
    }
    await db?.end();
    process.env = SAVED;
    setSecretKeySignalSink(null);
    __resetSecretKeyCacheForTests();
  });

  beforeEach(async () => {
    for (const t of ROTATION_TARGETS) await db.query(`TRUNCATE ${t.table}`);
    await db.query(`TRUNCATE instinct_events`);
  });

  async function seedCredential(name: string, header: string, refresh: string | null): Promise<void> {
    await db.query(
      `INSERT INTO instinct_connector_credentials (workspace_id, connector_name, base_url, auth_header_enc, refresh_token_enc)
       VALUES ('ws-1', $1, 'https://example.test', $2, $3)`,
      [name, encryptSecret(header), refresh === null ? null : encryptSecret(refresh)],
    );
  }

  async function seedAll(): Promise<void> {
    legacyMode();
    await seedCredential("c1", "Bearer one", "refresh-one");
    await seedCredential("c2", "Bearer two", null);
    await db.query(
      `INSERT INTO instinct_ms_tokens (user_email, access_token, refresh_token, expires_at, connected_by)
       VALUES ('a@example.test', $1, $2, NOW() + INTERVAL '1 hour', 'u-a'),
              ('b@example.test', 'raw-legacy-plaintext', 'raw-legacy-plaintext-r', NOW() + INTERVAL '1 hour', 'u-b')`,
      [encryptSecret("eyJ.access"), encryptSecret("0.A.refresh")],
    );
    await db.query(
      `INSERT INTO instinct_qbo_tokens (realm_id, access_token, refresh_token, expires_at, connected_by)
       VALUES ('realm-sealed', $1, $2, NOW() + INTERVAL '1 hour', 'u-a'),
              ('realm-plain', 'unsealed-qbo-a', 'unsealed-qbo-r', NOW() + INTERVAL '1 hour', 'u-b')`,
      [encryptSecret("eyJ.qbo-access"), encryptSecret("AB11.qbo-refresh")],
    );
    await db.query(`INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret) VALUES ('ws-1', 'acme', 'hs256', $1)`, [encryptSecret("shared-issuer-secret")]);
    await db.query(`INSERT INTO instinct_admin_mfa (id, user_id, workspace_id, encrypted_secret) VALUES ('m1', 'u-a', 'ws-1', $1)`, [encryptSecret("JBSWY3DPEHPK3PXP")]);
    await db.query(`INSERT INTO instinct_tenant_registry (tenant_id, org_name, status, db_url_encrypted) VALUES ('t-acme-ab12', 'Acme', 'active', $1)`, [
      encryptSecret("postgres://u:p@h/db"),
    ]);
    previousMode();
    await db.query(`INSERT INTO instinct_workspace_model_keys (workspace_id, provider, encrypted_key, key_hint) VALUES ('ws-1', 'openai', $1, '...ious')`, [encryptSecret("sk-previous")]);
    primaryMode();
  }

  async function snapshot(): Promise<string> {
    const parts: unknown[] = [];
    for (const t of ROTATION_TARGETS) {
      parts.push((await db.query(`SELECT ${t.columns.join(", ")} FROM ${t.table} ORDER BY ${t.pk}::text`)).rows);
    }
    return JSON.stringify(parts);
  }

  it("survey counts per table and column, by key", async () => {
    await seedAll();
    const counts = await surveySecrets(db);
    const by = (t: string, c: string) => counts.find((x) => x.table === t && x.column === c);
    expect(by("instinct_connector_credentials", "auth_header_enc")).toMatchObject({ present: true, legacy: 2 });
    expect(by("instinct_connector_credentials", "refresh_token_enc")).toMatchObject({ legacy: 1 });
    expect(by("instinct_ms_tokens", "access_token")).toMatchObject({ legacy: 1, plaintext: 1 });
    expect(by("instinct_workspace_model_keys", "encrypted_key")).toMatchObject({ previous: 1 });
    expect(by("instinct_qbo_tokens", "access_token")).toMatchObject({ present: true, legacy: 1, plaintext: 1 });
    expect(by("instinct_qbo_tokens", "refresh_token")).toMatchObject({ present: true, legacy: 1, plaintext: 1 });
    expect(by("instinct_delegation_issuers", "secret")).toMatchObject({ present: true, legacy: 1 });
    expect(totals(counts)).toEqual({ primary: 0, previous: 1, legacy: 10, plaintext: 4, unreadable: 0 });
  });

  it("rotates legacy and previous values to the primary; every value still opens", async () => {
    await seedAll();
    const r = await rotateSecrets(db, ROTATION_TARGETS, { batchSize: 2 });
    expect(r).toMatchObject({ rotated: 11, skippedConcurrent: 0, unreadable: 0, roundTripFailures: 0 });
    expect(totals(await surveySecrets(db))).toEqual({ primary: 11, previous: 0, legacy: 0, plaintext: 4, unreadable: 0 });

    const cred = (await db.query(`SELECT auth_header_enc, refresh_token_enc FROM instinct_connector_credentials WHERE connector_name = 'c1'`)).rows[0];
    expect(cred.auth_header_enc.startsWith(`v1.${PRIMARY_KID}.`)).toBe(true);
    expect(decryptSecret(cred.auth_header_enc)).toBe("Bearer one");
    expect(decryptSecret(cred.refresh_token_enc)).toBe("refresh-one");
    const ms = (await db.query(`SELECT access_token, refresh_token FROM instinct_ms_tokens WHERE connected_by = 'u-b'`)).rows[0];
    expect(ms).toEqual({ access_token: "raw-legacy-plaintext", refresh_token: "raw-legacy-plaintext-r" }); // plaintext untouched
    const qbo = (await db.query(`SELECT access_token, refresh_token FROM instinct_qbo_tokens ORDER BY realm_id`)).rows;
    expect(qbo[0]).toEqual({ access_token: "unsealed-qbo-a", refresh_token: "unsealed-qbo-r" }); // realm-plain untouched
    expect(qbo[1].access_token.startsWith(`v1.${PRIMARY_KID}.`)).toBe(true);
    expect(decryptSecret(qbo[1].access_token)).toBe("eyJ.qbo-access");
    expect(decryptSecret(qbo[1].refresh_token)).toBe("AB11.qbo-refresh");
    const mk = (await db.query(`SELECT encrypted_key FROM instinct_workspace_model_keys`)).rows[0].encrypted_key;
    expect(decryptSecretWithInfo(mk)).toMatchObject({ ok: true, value: "sk-previous", keyClass: "primary" });

    /* As the app sees it (no legacy key in the ring), all rotated values open. */
    allowLegacyKeyForRotation(false);
    setKeys({ INSTINCT_SECRET_KEY: KEY_PRIMARY, INSTINCT_JWT_SECRET: "a-different-jwt-secret-so-legacy-is-useless" });
    expect(decryptSecret((await db.query(`SELECT encrypted_secret FROM instinct_admin_mfa`)).rows[0].encrypted_secret)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptSecret((await db.query(`SELECT secret FROM instinct_delegation_issuers`)).rows[0].secret)).toBe("shared-issuer-secret");
    expect(decryptSecret((await db.query(`SELECT db_url_encrypted FROM instinct_tenant_registry`)).rows[0].db_url_encrypted)).toBe("postgres://u:p@h/db");
    allowLegacyKeyForRotation();
  });

  it("a re-run is a no-op", async () => {
    await seedAll();
    await rotateSecrets(db);
    const before = await snapshot();
    const again = await rotateSecrets(db);
    expect(again.rotated).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it("a crash mid-run keeps committed batches, and a re-run finishes the rest", async () => {
    legacyMode();
    for (let i = 0; i < 5; i++) await seedCredential(`crash-${i}`, `Bearer ${i}`, null);
    primaryMode();

    await expect(
      rotateSecrets(db, ROTATION_TARGETS, {
        batchSize: 2,
        beforeCommit: (i) => {
          if (i === 1) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const mid = (await surveySecrets(db)).find((c) => c.column === "auth_header_enc");
    expect(mid).toMatchObject({ primary: 2, legacy: 3 }); // batch 0 committed, batch 1 rolled back

    const resumed = await rotateSecrets(db, ROTATION_TARGETS, { batchSize: 2 });
    expect(resumed.rotated).toBe(3);
    const done = (await surveySecrets(db)).find((c) => c.column === "auth_header_enc");
    expect(done).toMatchObject({ primary: 5, legacy: 0 });
    const headers = (await db.query(`SELECT auth_header_enc FROM instinct_connector_credentials ORDER BY connector_name`)).rows.map((r) => decryptSecret(r.auth_header_enc));
    expect(headers).toEqual(["Bearer 0", "Bearer 1", "Bearer 2", "Bearer 3", "Bearer 4"]);
  });

  it("an unreadable value is counted and left untouched", async () => {
    setKeys({ INSTINCT_SECRET_KEY: "9".repeat(64) });
    await seedCredential("foreign", "Bearer foreign", null);
    const stored = (await db.query(`SELECT auth_header_enc FROM instinct_connector_credentials`)).rows[0].auth_header_enc;
    primaryMode();
    const r = await rotateSecrets(db);
    expect(r).toMatchObject({ rotated: 0, unreadable: 1 });
    expect((await db.query(`SELECT auth_header_enc FROM instinct_connector_credentials`)).rows[0].auth_header_enc).toBe(stored);
  });

  it("the app-key proof accepts a stored primary value or the app's event, and refuses a mismatch", async () => {
    await seedAll();
    expect(await proveAppKey(db, PRIMARY_KID)).toEqual({ ok: false, reason: "app_key_not_observed" });

    await db.query(`INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ('security.secret_key_primary_active', 'system', 'system', $1, NOW())`, [
      JSON.stringify({ primary_kid: "k0000000000000000" }),
    ]);
    expect(await proveAppKey(db, PRIMARY_KID)).toEqual({ ok: false, reason: "app_reports_different_key" });

    await db.query(`INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ('security.secret_key_primary_active', 'system', 'system', $1, NOW() + INTERVAL '1 second')`, [
      JSON.stringify({ primary_kid: PRIMARY_KID }),
    ]);
    expect(await proveAppKey(db, PRIMARY_KID)).toEqual({ ok: true, via: "app_event" });

    await db.query(`TRUNCATE instinct_events`);
    await seedCredential("written-by-app", "Bearer new", null); // primary mode: what the app writes after the env is set
    expect(await proveAppKey(db, PRIMARY_KID)).toEqual({ ok: true, via: "stored_value" });
  });
});
