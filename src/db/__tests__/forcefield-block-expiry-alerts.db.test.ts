/**
 * Forcefield block expiry (migration 290) and alert delivery (migration 291),
 * run against a REAL Postgres built from the REAL migrations 256, 269, 270, 290
 * and 291. Proves:
 *   - both migrations are idempotent (run twice);
 *   - the backfill gives legacy automatic rows a 14-day expiry and leaves admin
 *     rows permanent;
 *   - the lib's SQL (copied verbatim) runs against the schema: an expired
 *     automatic row is not served, an admin row persists, a re-run of an
 *     automatic block inserts 0 rows (the counting fix), an admin re-block clears
 *     an expiry;
 *   - the alert dedupe holds per incident + window, a failed delivery is
 *     re-claimable up to MAX_ATTEMPTS, and the silence count sees only delivered
 *     alerts.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const mig = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");

// Verbatim from src/lib/forcefield/blocked-fingerprints.ts (writeAutoRows).
const WRITE_AUTO = `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp, expires_at)
       SELECT $1, $2, f.fp, f.expires_at
         FROM unnest($3::text[], $4::timestamptz[]) AS f(fp, expires_at)
     ON CONFLICT (workspace_id, operator_key, fp) DO UPDATE
       SET expires_at = GREATEST(instinct_agent_blocked_fingerprints.expires_at, EXCLUDED.expires_at)
     WHERE instinct_agent_blocked_fingerprints.expires_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`;
// Verbatim from captureBlockedFingerprints (admin block).
const WRITE_ADMIN = `INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp, expires_at)
         SELECT $1, $2, unnest($3::text[]), NULL
       ON CONFLICT (workspace_id, operator_key, fp) DO UPDATE SET expires_at = NULL
       RETURNING (xmax = 0) AS inserted`;
// Verbatim from getBlockedFingerprints.
const READ_FPS = `SELECT DISTINCT fp, operator_key, expires_at
         FROM instinct_agent_blocked_fingerprints
        WHERE workspace_id = $1
          AND (expires_at IS NULL OR expires_at > now())`;
// Verbatim from src/lib/agent-operators.ts.
const BLOCK_OPERATOR = `INSERT INTO instinct_agent_operator_blocklist (workspace_id, operator_key, reason, blocked_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, operator_key)
       DO UPDATE SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = now(), expires_at = EXCLUDED.expires_at`;
const LIST_OPERATORS = `SELECT operator_key FROM instinct_agent_operator_blocklist
      WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > now())`;
// Verbatim from src/lib/forcefield-web/alerts.ts (liveAlertStore).
const CLAIM = `INSERT INTO instinct_forcefield_web_alerts
           (id, alert_kind, fingerprint, severity, title, body, site, attack_class, window_start)
         VALUES ($1, $2, $3, 'high', $4, $5, $6, $7, $8)
         ON CONFLICT (alert_kind, fingerprint) DO UPDATE
           SET attempts = instinct_forcefield_web_alerts.attempts + 1
         WHERE instinct_forcefield_web_alerts.delivery_status = 'failed'
           AND instinct_forcefield_web_alerts.attempts < $9`;
const RECORD = `UPDATE instinct_forcefield_web_alerts
            SET delivery_status = $3, delivery_detail = $4, dispatched_at = now()
          WHERE alert_kind = $1 AND fingerprint = $2`;
const COUNT_DELIVERED = `SELECT count(*) AS n FROM instinct_forcefield_web_alerts
          WHERE delivery_status = 'delivered'
            AND alert_kind <> 'alert_silence'
            AND dispatched_at > now() - ($1 || ' hours')::interval`;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

describeIfDb("Forcefield block expiry + alert delivery schema (migrations 290, 291)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await db.query(`DROP TABLE IF EXISTS instinct_agent_blocked_fingerprints, instinct_agent_operator_blocklist`);
    await db.query(mig("256_agent_operator_blocklist.sql"));
    await db.query(mig("269_agent_blocked_fingerprints.sql"));
    await db.query(mig("270_forcefield_web_alerts.sql"));
    // Legacy rows written before 290: one automatic, one admin, each 30 days old.
    await db.query(`INSERT INTO instinct_agent_blocked_fingerprints (workspace_id, operator_key, fp, created_at)
                    VALUES ('legacy', 'auto:trap', 'fp-auto', now() - interval '30 days'),
                           ('legacy', 'op-admin', 'fp-admin', now() - interval '30 days')`);
    await db.query(`INSERT INTO instinct_agent_operator_blocklist (workspace_id, operator_key, blocked_by, blocked_at)
                    VALUES ('legacy', 'op-auto', 'forcefield.auto', now() - interval '30 days'),
                           ('legacy', 'op-human', 'cto@example.invalid', now() - interval '30 days')`);
    for (let i = 0; i < 2; i++) {
      await db.query(mig("290_forcefield_block_expiry.sql")); // idempotent
      await db.query(mig("291_forcefield_alert_delivery.sql"));
    }
  });
  afterAll(async () => { await db?.end(); });

  describe("migration 290 backfill", () => {
    it("legacy automatic fingerprint rows get created_at + 14 days, so a 30-day-old one is already expired", async () => {
      const served = (await db.query(READ_FPS, ["legacy"])).rows.map((r) => r.fp);
      expect(served).toEqual(["fp-admin"]);
    });
    it("legacy admin rows stay permanent (expires_at NULL)", async () => {
      const r = await db.query(`SELECT expires_at FROM instinct_agent_blocked_fingerprints WHERE fp = 'fp-admin'`);
      expect(r.rows[0].expires_at).toBeNull();
    });
    it("legacy automatic operator blocks lapse; human operator blocks persist", async () => {
      const keys = (await db.query(LIST_OPERATORS, ["legacy"])).rows.map((r) => r.operator_key);
      expect(keys).toEqual(["op-human"]);
    });
  });

  describe("fingerprint rows", () => {
    beforeEach(async () => { await db.query(`DELETE FROM instinct_agent_blocked_fingerprints WHERE workspace_id = 'w1'`); });

    it("an expired automatic row is not served; an unexpired one is", async () => {
      await db.query(WRITE_AUTO, ["w1", "auto:a", ["fp-old", "fp-new"], [iso(-DAY), iso(DAY)]]);
      const served = (await db.query(READ_FPS, ["w1"])).rows.map((r) => r.fp);
      expect(served).toEqual(["fp-new"]);
    });

    it("COUNTING FIX: a re-run inserts 0 rows (it only refreshes the expiry)", async () => {
      const first = await db.query(WRITE_AUTO, ["w1", "auto:a", ["fp1", "fp2"], [iso(DAY), iso(DAY)]]);
      expect(first.rows.filter((r) => r.inserted)).toHaveLength(2);
      const again = await db.query(WRITE_AUTO, ["w1", "auto:a", ["fp1", "fp2"], [iso(5 * DAY), iso(5 * DAY)]]);
      expect(again.rows.filter((r) => r.inserted)).toHaveLength(0);
      const exp = await db.query(`SELECT expires_at FROM instinct_agent_blocked_fingerprints WHERE fp = 'fp1' AND workspace_id = 'w1'`);
      expect(new Date(exp.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 4 * DAY);
    });

    it("an automatic write never puts an expiry on an ADMIN row", async () => {
      await db.query(WRITE_ADMIN, ["w1", "auto:a", ["fpX"]]);
      await db.query(WRITE_AUTO, ["w1", "auto:a", ["fpX"], [iso(DAY)]]);
      const r = await db.query(`SELECT expires_at FROM instinct_agent_blocked_fingerprints WHERE fp = 'fpX' AND workspace_id = 'w1'`);
      expect(r.rows[0].expires_at).toBeNull();
    });

    it("an admin block clears a prior automatic expiry (a human block is permanent)", async () => {
      await db.query(WRITE_AUTO, ["w1", "op", ["fpY"], [iso(-DAY)]]);
      const res = await db.query(WRITE_ADMIN, ["w1", "op", ["fpY"]]);
      expect(res.rows.filter((r) => r.inserted)).toHaveLength(0);
      expect((await db.query(READ_FPS, ["w1"])).rows.map((r) => r.fp)).toEqual(["fpY"]);
    });
  });

  describe("operator blocklist", () => {
    it("an automatic operator block expires; a human re-block clears the expiry", async () => {
      await db.query(BLOCK_OPERATOR, ["w2", "op-a", "auto: x", "forcefield.auto", iso(-1000)]);
      expect((await db.query(LIST_OPERATORS, ["w2"])).rows).toHaveLength(0);
      await db.query(BLOCK_OPERATOR, ["w2", "op-a", "manual", "cto", null]);
      expect((await db.query(LIST_OPERATORS, ["w2"])).rows.map((r) => r.operator_key)).toEqual(["op-a"]);
    });
  });

  describe("alerts (migration 291)", () => {
    beforeEach(async () => { await db.query(`TRUNCATE instinct_forcefield_web_alerts`); });
    const claim = (key: string, kind = "payload_attack") =>
      db.query(CLAIM, [`id-${kind}-${key}`, kind, key, "t", "b", "ogiam.com", "sql_injection", new Date().toISOString(), 5]);

    it("a new incident is claimed once; a duplicate in its window is not", async () => {
      expect((await claim("k1")).rowCount).toBe(1);
      await db.query(RECORD, ["payload_attack", "k1", "delivered", null]);
      expect((await claim("k1")).rowCount).toBe(0);
      expect((await claim("k2")).rowCount).toBe(1); // the next window is a new key
    });

    it("a FAILED delivery is re-claimable until attempts run out", async () => {
      await claim("k3");
      await db.query(RECORD, ["payload_attack", "k3", "failed", "email:no_mail_from"]);
      for (let i = 0; i < 4; i++) expect((await claim("k3")).rowCount).toBe(1);
      expect((await claim("k3")).rowCount).toBe(0); // attempts = 5
      const r = await db.query(`SELECT attempts, delivery_detail FROM instinct_forcefield_web_alerts WHERE fingerprint = 'k3'`);
      expect(r.rows[0]).toMatchObject({ attempts: 5, delivery_detail: "email:no_mail_from" });
    });

    it("the silence count sees delivered alerts only, and never the silence alert itself", async () => {
      await claim("d1"); await db.query(RECORD, ["payload_attack", "d1", "delivered", null]);
      await claim("f1"); await db.query(RECORD, ["payload_attack", "f1", "failed", "x"]);
      await claim("s1", "alert_silence"); await db.query(RECORD, ["alert_silence", "s1", "delivered", null]);
      const n = Number((await db.query(COUNT_DELIVERED, ["24"])).rows[0].n);
      expect(n).toBe(1);
    });
  });
});
