/**
 * Forcefield self-serve onboarding against a REAL Postgres built from the REAL
 * migrations (284, 285, 288, 193, 270, 291 and the new 298). Runs the lib SQL
 * itself, not copies of it:
 *   - 298 applies twice (idempotent) and adds the columns + guarded indexes;
 *   - startForcefieldOnboarding stores only the setup key hash, and a second start for the
 *     same open site + email rotates the key instead of adding a row;
 *   - the challenge row lives in the onboarding workspace and getOnboardingState
 *     reads it back;
 *   - verifyOwnership's claim provisions exactly one tenant;
 *   - the alert-address set / confirm (single use) / unsubscribe SQL;
 *   - the tenant notification cron's live SQL: confirmed-only listing, first
 *     evidence claimed once, the tenant-SCOPED incident query (another tenant's
 *     events never appear), the tenant alert claim/outcome (never counted as an
 *     operator delivery) and the once-a-day digest claim.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
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
  writeQuery: async (sql: string, params?: unknown[]) => ({ rows: (await db.query(sql, params ?? [])).rows }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));

import { hashToken, type TenantQuery } from "@/lib/forcefield-web/tenants";
import { startForcefieldOnboarding, getOnboardingState, verifyOwnership, ONBOARDING_WORKSPACE, verificationPlatform } from "@/lib/forcefield-web/onboarding";
import { setNotifyEmail, confirmNotifyEmail, unsubscribeNotify, mintUnsubscribeToken } from "@/lib/forcefield-web/tenant-notify";
import { liveTenantNotifyDeps, TENANT_DELIVERED } from "@/lib/forcefield-web/tenant-alerts";
import { tenantAlertFromIncident } from "@/lib/forcefield-web/tenant-alerts";
import { buildIncidents } from "@/lib/forcefield-web/incidents";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATIONS = [
  "284_forcefield_tenants.sql",
  "285_forcefield_signup_requests.sql",
  "288_forcefield_tenant_connector.sql",
  "193_target_ownership_verification.sql",
  "270_forcefield_web_alerts.sql",
  "291_forcefield_alert_delivery.sql",
  "298_forcefield_self_serve_onboarding.sql",
];
const read = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");
const allow = async () => ({ allowed: true });
const q: TenantQuery = async (sql, params) => (await db.query(sql, params ?? [])).rows as never;

describeIfDb("Forcefield self-serve onboarding (real Postgres)", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS forcefield_signup_requests, forcefield_tenants, instinct_target_verifications, instinct_forcefield_web_alerts CASCADE`);
    await db.query(`CREATE TABLE IF NOT EXISTS site_analytics_events (id BIGSERIAL PRIMARY KEY)`);
    for (const col of ["event_type TEXT", "path TEXT", "country TEXT", "referrer_host TEXT", "props JSONB", "created_at TIMESTAMPTZ NOT NULL DEFAULT now()"]) {
      await db.query(`ALTER TABLE site_analytics_events ADD COLUMN IF NOT EXISTS ${col}`);
    }
    for (const f of MIGRATIONS) await db.query(read(f));
    await db.query(read("298_forcefield_self_serve_onboarding.sql")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query(`TRUNCATE forcefield_signup_requests, forcefield_tenants, instinct_target_verifications, instinct_forcefield_web_alerts`);
    await db.query(`DELETE FROM site_analytics_events WHERE forcefield_tenant_id IS NOT NULL`);
  });

  it("298 adds the columns and indexes", async () => {
    const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('forcefield_signup_requests','forcefield_tenants')`);
    const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const c of ["forcefield_signup_requests.kind", "forcefield_signup_requests.setup_key_sha256", "forcefield_signup_requests.ownership_verified_at", "forcefield_signup_requests.concierge_requested_at", "forcefield_tenants.notify_email", "forcefield_tenants.notify_status", "forcefield_tenants.notify_confirm_token_sha256", "forcefield_tenants.first_evidence_at", "forcefield_tenants.notify_digest_sent_on"]) {
      expect([c, have.has(c)]).toEqual([c, true]);
    }
    const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('forcefield_signup_requests_setup_key','forcefield_tenants_notify_confirmed_idx')`);
    expect(idx.rows).toHaveLength(2);
    const def = await db.query(`SELECT kind FROM forcefield_signup_requests LIMIT 0`);
    expect(def.fields[0].name).toBe("kind");
  });

  it("start stores only the key hash; a second start rotates the key on the same row", async () => {
    const a = await startForcefieldOnboarding({ raw: { siteUrl: "acme.com", email: "qa@thewolfpack.agency" }, ipHash: "h" }, { q, limiter: allow });
    expect(a.reason).toBe("ok");
    const rows = await db.query(`SELECT id, kind, setup_key_sha256, status FROM forcefield_signup_requests`);
    expect(rows.rows).toEqual([{ id: a.requestId, kind: "self_serve", setup_key_sha256: hashToken(a.setupKey!), status: "pending" }]);
    const ver = await db.query(`SELECT workspace_id, platform, verification_status FROM instinct_target_verifications`);
    expect(ver.rows).toEqual([{ workspace_id: ONBOARDING_WORKSPACE, platform: verificationPlatform(a.requestId!), verification_status: "pending" }]);

    const b = await startForcefieldOnboarding({ raw: { siteUrl: "ACME.com", email: "QA@thewolfpack.agency" }, ipHash: "h" }, { q, limiter: allow });
    expect(b.requestId).toBe(a.requestId);
    expect((await db.query(`SELECT count(*)::int AS n FROM forcefield_signup_requests`)).rows[0].n).toBe(1);
    expect((await getOnboardingState(a.setupKey!, { q })).ok).toBe(false); // old key no longer works
    const st = await getOnboardingState(b.setupKey!, { q, connection: async () => ({ connected: false, everConnected: false, lastEventAt: null }) });
    expect(st.ok && st.state.ownership.instructions[0].value).toMatch(/^ogiam-site-verification=[0-9a-f]{64}$/);
  });

  it("verify provisions exactly one tenant and moves the request to approved", async () => {
    const a = await startForcefieldOnboarding({ raw: { siteUrl: "acme.com", email: "qa@thewolfpack.agency" }, ipHash: "h" }, { q, limiter: allow });
    const check = (async () => ({ ok: true })) as never;
    const notify = jest.fn(async () => ({ ok: true, reason: "ok" as const, delivered: true }));
    const [r1, r2] = await Promise.all([
      verifyOwnership(a.setupKey!, { q, limiter: allow, check, notify }),
      verifyOwnership(a.setupKey!, { q, limiter: allow, check, notify }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM forcefield_tenants`)).rows[0].n).toBe(1);
    const req = await db.query(`SELECT status, tenant_id, reviewed_by, ownership_method FROM forcefield_signup_requests`);
    expect(req.rows[0]).toMatchObject({ status: "approved", tenant_id: oks[0].tenant!.id, reviewed_by: "self_serve:ownership", ownership_method: "dns_txt" });
    const stored = await db.query(`SELECT token_sha256 FROM forcefield_tenants`);
    expect(stored.rows[0].token_sha256).toBe(hashToken(oks[0].token!));
  });

  async function tenant(site = "acme.com"): Promise<string> {
    const r = await db.query(`INSERT INTO forcefield_tenants (name, site_label, token_sha256) VALUES ($1, $1, md5(random()::text)) RETURNING id`, [site]);
    return r.rows[0].id;
  }

  it("alert address: pending -> confirmed once -> unsubscribed, only hashes stored", async () => {
    const id = await tenant();
    const mails: { text: string }[] = [];
    const r = await setNotifyEmail(id, "qa@thewolfpack.agency", { q, limiter: allow, send: async (m) => { mails.push(m); return { delivered: true, reason: "ok" }; } });
    expect(r.ok).toBe(true);
    const token = decodeURIComponent(/confirm\?token=(\S+)/.exec(mails[0].text)![1]);
    const row = (await db.query(`SELECT notify_status, notify_confirm_token_sha256, notify_confirm_expires_at FROM forcefield_tenants WHERE id = $1`, [id])).rows[0];
    expect(row.notify_status).toBe("pending");
    expect(row.notify_confirm_token_sha256).toBe(hashToken(token));
    expect(row.notify_confirm_expires_at).not.toBeNull();

    expect((await confirmNotifyEmail(token, { q })).ok).toBe(true);
    expect((await confirmNotifyEmail(token, { q })).reason).toBe("already_confirmed");
    const after = (await db.query(`SELECT notify_status, notify_confirm_token_sha256, notify_confirmed_at FROM forcefield_tenants WHERE id = $1`, [id])).rows[0];
    expect(after.notify_status).toBe("confirmed");
    expect(after.notify_confirm_token_sha256).toBeNull();
    expect(after.notify_confirmed_at).not.toBeNull();

    expect((await unsubscribeNotify(mintUnsubscribeToken(id, "qa@thewolfpack.agency"), { q })).ok).toBe(true);
    expect((await db.query(`SELECT notify_status FROM forcefield_tenants WHERE id = $1`, [id])).rows[0].notify_status).toBe("unsubscribed");
  });

  it("the cron's live SQL: confirmed-only, first evidence once, tenant-scoped incidents, tenant claims, daily digest claim", async () => {
    const mine = await tenant("acme.com");
    const other = await tenant("other.example");
    const pending = await tenant("pending.example");
    await db.query(`UPDATE forcefield_tenants SET notify_email = 'qa@thewolfpack.agency', notify_status = 'confirmed', notify_confirmed_at = now() - interval '2 hours' WHERE id IN ($1, $2)`, [mine, other]);
    await db.query(`UPDATE forcefield_tenants SET notify_email = 'p@thewolfpack.agency', notify_status = 'pending' WHERE id = $1`, [pending]);
    const ev = `INSERT INTO site_analytics_events (event_type, path, country, props, forcefield_tenant_id, created_at) VALUES ($1, $2, 'US', $3::jsonb, $4, now() - interval '30 minutes')`;
    await db.query(ev, ["site.agent_payload_attack", "/q?id=1'", JSON.stringify({ site: "acme.com", attack: "sql_injection", blocked: "true" }), mine]);
    await db.query(ev, ["site.agent_payload_attack", "/q?id=2'", JSON.stringify({ site: "acme.com", attack: "sql_injection" }), mine]);
    await db.query(ev, ["site.agent_trap_tripped", "/trap", JSON.stringify({ site: "other.example" }), other]);
    await db.query(ev, ["site.agent_payload_attack", "/synthetic", JSON.stringify({ site: "acme.com", attack: "xss", synthetic: "true" }), mine]);

    const d = liveTenantNotifyDeps();
    const listed = await d.listConfirmedTenants();
    expect(listed.map((t) => t.id).sort()).toEqual([mine, other].sort());

    expect(await d.firstEventAt(mine)).not.toBeNull();
    expect(await d.claimFirstEvidence(mine)).toBe(true);
    expect(await d.claimFirstEvidence(mine)).toBe(false);
    await d.releaseFirstEvidence(mine);
    expect(await d.claimFirstEvidence(mine)).toBe(true);

    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const until = new Date(Date.now() + 1000).toISOString();
    const groups = await d.listTenantEvents(mine, since, until);
    // The synthetic event and the other tenant's never appear.
    expect(groups.map((g) => [g.attackClass, g.outcome, g.count]).sort()).toEqual([["sql_injection", "blocked", 1], ["sql_injection", "recorded", 1]]);
    expect((await d.listTenantEvents(other, since, until)).map((g) => g.kind)).toEqual(["honeytoken_trip"]);
    const [inc] = buildIncidents(groups);
    expect(inc.route).toBe("immediate"); // one request was not blocked

    const alert = tenantAlertFromIncident({ id: mine, siteLabel: "acme.com" }, inc);
    expect(await d.claimAlert(alert)).toBe(true);
    expect(await d.claimAlert(alert)).toBe(false); // in flight: not re-claimed
    await d.recordOutcome(alert, { status: "delivered", inAppRecipients: 0, emailAttempted: 1, emailDelivered: 1, detail: "tenant" });
    const rows = (await db.query(`SELECT alert_kind, delivery_status FROM instinct_forcefield_web_alerts`)).rows;
    expect(rows).toEqual([{ alert_kind: "tenant_hostile_incident", delivery_status: TENANT_DELIVERED }]);
    // The operator silence check counts delivery_status = 'delivered' only.
    expect((await db.query(`SELECT count(*)::int AS n FROM instinct_forcefield_web_alerts WHERE delivery_status = 'delivered'`)).rows[0].n).toBe(0);

    expect(await d.claimDigest(mine)).toBe(true);
    expect(await d.claimDigest(mine)).toBe(false);
    await db.query(`UPDATE forcefield_tenants SET notify_digest_sent_on = current_date - 1 WHERE id = $1`, [mine]);
    expect(await d.claimDigest(mine)).toBe(true);
  });
});
