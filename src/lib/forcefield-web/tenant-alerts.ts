/**
 * Forcefield TENANT notifications: what a confirmed tenant address receives.
 *
 *   - FIRST HOUR: "Your first hour with Forcefield on <site>", once per tenant,
 *     on the first run at least FIRST_HOUR_SETTLE_MS after the tenant's first
 *     REAL event (synthetic monitor traffic excluded), or after the address is
 *     confirmed, whichever is later: agents seen / welcomed / slowed / blocked,
 *     the top few by activity (tenant-activity.ts), and the dashboard link.
 *   - IMMEDIATE ALERTS: the same severity routing as the operator path. The
 *     tenant's own events (site_analytics_events.forcefield_tenant_id, a
 *     tenant-scoped copy of HOSTILE_EVENTS_SQL) are grouped into incidents with
 *     buildIncidents, and ONLY incidents routed "immediate" (a decoy trip, or a
 *     request that was not blocked) send an email now: alertFromIncident,
 *     re-scoped to the tenant's site label with a tenant-bound dedupe key,
 *     rendered by the shared template with audience "tenant" (dashboard links,
 *     never /admin) plus the manage + unsubscribe footer. A fully blocked or
 *     contained incident never sends an immediate email; the daily summary
 *     covers it. Claimed, delivered and recorded through dispatchForcefieldAlert,
 *     so a tenant alert never collides with, or suppresses, the operator alert.
 *   - DAILY DIGEST: one summary per tenant per UTC day (the 13:00 UTC run),
 *     only when the site saw any automated traffic that day.
 *
 * Only tenants whose address is CONFIRMED are considered, and every email goes
 * through sendForcefieldTenantMail, which enforces the recipient allowlist. The
 * operator alert path (alerts.ts) is unchanged and still alerts Wolfpack about
 * every incident.
 *
 * Runs from /api/cron/forcefield-tenant-notify. Injectable deps; never throws.
 */
import { createHash } from "node:crypto";
import { query } from "@/lib/db";
import { trackEventAwait } from "@/lib/analytics";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";
import {
  alertFromIncident,
  dispatchForcefieldAlert,
  eventGroupFromRow,
  windowStartOf,
  HOSTILE_EVENTS_SQL,
  ALERT_WINDOW_HOURS,
  MAX_ATTEMPTS,
  type ForcefieldAlert,
  type ForcefieldAlertDeps,
  type DeliveryOutcome,
} from "@/lib/forcefield-web/alerts";
import { buildIncidents, type HostileEventGroup, type HostileIncident } from "@/lib/forcefield-web/incidents";
import { renderForcefieldAlertEmail } from "@/lib/forcefield-web/alert-email";
import { getPublicForcefieldStats, type PublicForcefieldStats } from "@/lib/forcefield-web/public-stats";
import { sendForcefieldTenantMail, type TenantMail, type TenantMailResult } from "@/lib/forcefield-web/tenant-mail";
import { renderFirstHourEmail, renderTenantDigestEmail, withTenantFooter } from "@/lib/forcefield-web/tenant-email";
import { getTenantActivity, type TenantActivity } from "@/lib/forcefield-web/tenant-activity";
import { mintUnsubscribeToken } from "@/lib/forcefield-web/tenant-notify";

/** The UTC hour the daily digest goes out (13:00 UTC = 9:00 AM US Eastern in summer). */
export const DIGEST_HOUR_UTC = 13;
/** At most this many incident emails per tenant per run (a flood guard). */
export const MAX_ALERTS_PER_TENANT_RUN = 10;
const LOOKBACK_HOURS = 24;
/** Wait this long after the first real event, so the first-hour email has
 *  something to summarize. With the 10-minute cron it arrives 5 to 15 minutes
 *  after the first visitor. */
export const FIRST_HOUR_SETTLE_MS = 5 * 60 * 1000;

export interface ConfirmedTenant {
  id: string;
  name: string;
  siteLabel: string;
  email: string;
  confirmedAt: string;
  firstEvidenceAt: string | null;
}

export interface TenantNotifyDeps {
  listConfirmedTenants: () => Promise<ConfirmedTenant[]>;
  /** When the tenant's first REAL event arrived (synthetic excluded), or null. */
  firstEventAt: (tenantId: string) => Promise<string | null>;
  /** Who visited since an instant (tenant-activity.ts). */
  activity: (tenantId: string, sinceIso: string) => Promise<TenantActivity>;
  claimFirstEvidence: (tenantId: string) => Promise<boolean>;
  releaseFirstEvidence: (tenantId: string) => Promise<void>;
  stats: (tenantId: string, rangeDays: number) => Promise<PublicForcefieldStats>;
  /** This tenant's hostile events in [sinceIso, untilIso), synthetic excluded,
   *  collapsed into groups (HOSTILE_EVENTS_SQL scoped by forcefield_tenant_id). */
  listTenantEvents: (tenantId: string, sinceIso: string, untilIso: string) => Promise<HostileEventGroup[]>;
  claimAlert: (alert: ForcefieldAlert) => Promise<boolean>;
  recordOutcome: (alert: ForcefieldAlert, outcome: DeliveryOutcome) => Promise<void>;
  claimDigest: (tenantId: string) => Promise<boolean>;
  send: (mail: TenantMail) => Promise<TenantMailResult>;
  track: (event: TenantTrackedEvent, payload: Record<string, string | number | boolean>) => Promise<void>;
  baseUrl: string;
  unsubscribeToken: (tenantId: string, email: string) => string;
}

/** Every event the tenant run records: whatever the shared dispatch path tracks
 *  (alerts.ts TrackedEvent) plus the tenant's own. All are InstinctEventType. */
export type TenantTrackedEvent =
  | Parameters<ForcefieldAlertDeps["track"]>[0]
  | "forcefield.tenant_first_evidence_sent"
  | "forcefield.tenant_digest_sent";

export interface TenantNotifyReport {
  tenants: number;
  firstEvidence: number;
  /** Tenant incidents left for the daily summary (fully blocked/contained). */
  digestOnly: number;
  alertsDispatched: number;
  alertsDelivered: number;
  digests: number;
  blocked: number;
}

const hash24 = (parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);

/** The tenant-scoped dedupe key: the incident key, bound to the tenant. */
export function tenantIncidentKey(tenantId: string, incidentKey: string): string {
  return hash24(["tenant", tenantId, incidentKey]);
}

/** An incident's immediate alert, re-scoped to the tenant: its site label (never
 *  the event's own site prop) and a tenant-bound dedupe key. */
export function tenantAlertFromIncident(tenant: Pick<ConfirmedTenant, "id" | "siteLabel">, inc: HostileIncident): ForcefieldAlert {
  const base = alertFromIncident({ ...inc, site: tenant.siteLabel });
  return { ...base, site: tenant.siteLabel, dedupeKey: tenantIncidentKey(tenant.id, base.dedupeKey), metadata: { ...(base.metadata ?? {}), audience: "tenant", tenant_id: tenant.id } };
}

/** Render one tenant alert: the shared template (tenant audience) + footer. */
export function renderTenantAlert(alert: ForcefieldAlert, tenant: ConfirmedTenant, baseUrl: string, unsubscribeToken: string) {
  const email = renderForcefieldAlertEmail(alert, { audience: "tenant", baseUrl, recipients: [tenant.email], tenantName: tenant.name !== tenant.siteLabel ? tenant.name : undefined });
  return withTenantFooter(email, tenant.siteLabel, tenant.email, { baseUrl, unsubscribeToken });
}

function counts(s: PublicForcefieldStats) {
  return { agentsDetected: s.agentsDetected, welcomed: s.welcomed, hostile: s.hostile, trapped: s.trapped, probed: s.probed, payloads: s.payloads };
}

export async function runTenantNotifications(deps: TenantNotifyDeps, now: Date = new Date()): Promise<TenantNotifyReport> {
  const report: TenantNotifyReport = { tenants: 0, firstEvidence: 0, digestOnly: 0, alertsDispatched: 0, alertsDelivered: 0, digests: 0, blocked: 0 };
  let tenants: ConfirmedTenant[] = [];
  try {
    tenants = await deps.listConfirmedTenants();
  } catch {
    return report;
  }
  report.tenants = tenants.length;
  const digestHour = now.getUTCHours() === DIGEST_HOUR_UTC;

  for (const t of tenants) {
    const unsub = deps.unsubscribeToken(t.id, t.email);
    const links = { baseUrl: deps.baseUrl, unsubscribeToken: unsub };

    // 1. First hour.
    if (!t.firstEvidenceAt) {
      try {
        const first = await deps.firstEventAt(t.id);
        const settled = !!first && now.getTime() - Date.parse(first) >= FIRST_HOUR_SETTLE_MS;
        if (first && settled && (await deps.claimFirstEvidence(t.id))) {
          const activity = await deps.activity(t.id, first);
          const mail = renderFirstHourEmail({ site: t.siteLabel, to: t.email, firstEventAt: first, activity, ...links });
          const res = await deps.send({ to: t.email, subject: mail.subject, text: mail.text, html: mail.html, purpose: "first_evidence", tenantId: t.id });
          if (res.delivered) {
            report.firstEvidence++;
            await deps.track("forcefield.tenant_first_evidence_sent", { tenant_id: t.id, site: t.siteLabel, kind: "first_hour", agents: activity.counts.agentsSeen, blocked: activity.counts.blocked }).catch(() => {});
          } else if (res.reason === "recipient_not_allowlisted") {
            report.blocked++;
          } else {
            await deps.releaseFirstEvidence(t.id).catch(() => {}); // retry next run
          }
        }
      } catch {
        /* next tenant */
      }
    }

    // 2. Immediate alerts: this tenant's incidents since it confirmed, routed
    //    exactly like the operator scan; only "immediate" incidents send now.
    try {
      const floor = windowStartOf(new Date(now.getTime() - LOOKBACK_HOURS * 3600_000));
      const since = new Date(Math.max(Date.parse(t.confirmedAt) || 0, Date.parse(floor))).toISOString();
      const incidents = buildIncidents(await deps.listTenantEvents(t.id, since, new Date(now.getTime() + 1).toISOString()));
      const immediate = incidents.filter((i) => i.route === "immediate");
      report.digestOnly += incidents.length - immediate.length;
      for (const inc of immediate.slice(0, MAX_ALERTS_PER_TENANT_RUN)) {
        const alert = tenantAlertFromIncident(t, inc);
        const outcome = await dispatchForcefieldAlert(alert, {
          claimAlert: deps.claimAlert,
          recordOutcome: deps.recordOutcome,
          track: deps.track,
          deliver: async (a) => {
            const email = renderTenantAlert(a, t, deps.baseUrl, unsub);
            const res = await deps.send({ to: t.email, subject: email.subject, text: email.text, html: email.html, purpose: "alert", tenantId: t.id });
            if (res.reason === "recipient_not_allowlisted") report.blocked++;
            return { status: res.delivered ? "delivered" : "failed", inAppRecipients: 0, emailAttempted: 1, emailDelivered: res.delivered ? 1 : 0, detail: res.delivered ? "tenant" : `tenant_email:${res.reason}` };
          },
        });
        if (!outcome) continue;
        report.alertsDispatched++;
        if (outcome.status === "delivered") report.alertsDelivered++;
      }
    } catch {
      /* next tenant */
    }

    // 3. Daily digest.
    if (digestHour) {
      try {
        const s = await deps.stats(t.id, 1);
        if (s.agentsDetected > 0 && (await deps.claimDigest(t.id))) {
          const mail = renderTenantDigestEmail({ site: t.siteLabel, to: t.email, day: now.toISOString().slice(0, 10), counts: counts(s), attacks: s.attacks, ...links });
          const res = await deps.send({ to: t.email, subject: mail.subject, text: mail.text, html: mail.html, purpose: "digest", tenantId: t.id });
          if (res.delivered) {
            report.digests++;
            await deps.track("forcefield.tenant_digest_sent", { tenant_id: t.id, site: t.siteLabel, hostile: s.hostile, agents: s.agentsDetected }).catch(() => {});
          } else if (res.reason === "recipient_not_allowlisted") report.blocked++;
        }
      } catch {
        /* next tenant */
      }
    }
  }
  return report;
}

/* ------------------------------ live adapters ----------------------------- */

type Row = Record<string, unknown>;
const rows = async <T,>(sql: string, params: unknown[]): Promise<T[]> => (await query<Row>(sql, params)).rows as T[];

/** The operator collapse query (HOSTILE_EVENTS_SQL), scoped to ONE tenant's
 *  rows: same columns, same grouping, plus forcefield_tenant_id = $5. Derived,
 *  never copied, so the two cannot drift; the guard below fails at load if the
 *  shared query's WHERE clause ever changes shape. */
const SCOPE_ANCHOR = "WHERE event_type = ANY($4::text[])";
if (!HOSTILE_EVENTS_SQL.includes(SCOPE_ANCHOR)) throw new Error("tenant-alerts: HOSTILE_EVENTS_SQL changed shape; update the tenant scope");
export const TENANT_EVENTS_SQL = HOSTILE_EVENTS_SQL.replace(SCOPE_ANCHOR, `WHERE forcefield_tenant_id = $5\n    AND event_type = ANY($4::text[])`);

const HOSTILE_EVENT_TYPES = ["site.agent_trap_tripped", "site.agent_payload_attack"];

/** Tenant alert rows share the alert table under their own kind prefix and a
 *  distinct delivered status, so the operator silence check never counts a
 *  tenant email as an operator delivery. */
export const TENANT_KIND_PREFIX = "tenant_";
export const TENANT_DELIVERED = "tenant_delivered";

export function liveTenantNotifyDeps(): TenantNotifyDeps {
  return {
    listConfirmedTenants: async () =>
      (await rows<{ id: string; name: string; site_label: string; notify_email: string; notify_confirmed_at: string; first_evidence_at: string | null }>(
        `SELECT id, name, site_label, notify_email, notify_confirmed_at::text AS notify_confirmed_at, first_evidence_at::text AS first_evidence_at
           FROM forcefield_tenants
          WHERE status = 'active' AND notify_status = 'confirmed' AND notify_email IS NOT NULL
          ORDER BY created_at LIMIT 500`,
        [],
      )).map((r) => ({ id: r.id, name: r.name, siteLabel: r.site_label, email: r.notify_email, confirmedAt: r.notify_confirmed_at, firstEvidenceAt: r.first_evidence_at })),
    firstEventAt: async (tenantId) =>
      (await rows<{ at: string | null }>(
        `SELECT min(created_at)::text AS at FROM site_analytics_events
          WHERE forcefield_tenant_id = $1 AND COALESCE(props->>'synthetic', '') <> 'true'`,
        [tenantId],
      ))[0]?.at ?? null,
    activity: (tenantId, sinceIso) => getTenantActivity(tenantId, sinceIso),
    claimFirstEvidence: async (tenantId) =>
      (await rows(`UPDATE forcefield_tenants SET first_evidence_at = now() WHERE id = $1 AND first_evidence_at IS NULL RETURNING id`, [tenantId])).length > 0,
    releaseFirstEvidence: async (tenantId) => {
      await rows(`UPDATE forcefield_tenants SET first_evidence_at = NULL WHERE id = $1 RETURNING id`, [tenantId]);
    },
    stats: (tenantId, rangeDays) => getPublicForcefieldStats(rangeDays, undefined, tenantId),
    listTenantEvents: async (tenantId, sinceIso, untilIso) =>
      (await rows<Parameters<typeof eventGroupFromRow>[0]>(TENANT_EVENTS_SQL, [sinceIso, untilIso, ALERT_WINDOW_HOURS, HOSTILE_EVENT_TYPES, tenantId])).map(eventGroupFromRow),
    claimAlert: async (alert) => {
      const kind = `${TENANT_KIND_PREFIX}${alert.kind}`;
      const res = await query(
        `INSERT INTO instinct_forcefield_web_alerts
           (id, alert_kind, fingerprint, severity, title, body, site, attack_class, window_start)
         VALUES ($1, $2, $3, 'high', $4, $5, $6, $7, $8)
         ON CONFLICT (alert_kind, fingerprint) DO UPDATE
           SET attempts = instinct_forcefield_web_alerts.attempts + 1
         WHERE instinct_forcefield_web_alerts.delivery_status = 'failed'
           AND instinct_forcefield_web_alerts.attempts < $9`,
        [hash24([kind, alert.dedupeKey]), kind, alert.dedupeKey, alert.title, alert.body, alert.site ?? null, alert.attackClass ?? null, alert.windowStart ?? null, MAX_ATTEMPTS],
      );
      return (res.rowCount ?? 0) > 0;
    },
    recordOutcome: async (alert, outcome) => {
      await query(
        `UPDATE instinct_forcefield_web_alerts SET delivery_status = $3, delivery_detail = $4, dispatched_at = now()
          WHERE alert_kind = $1 AND fingerprint = $2`,
        [`${TENANT_KIND_PREFIX}${alert.kind}`, alert.dedupeKey, outcome.status === "delivered" ? TENANT_DELIVERED : "failed", outcome.detail || null],
      );
    },
    claimDigest: async (tenantId) =>
      (await rows(
        `UPDATE forcefield_tenants SET notify_digest_sent_on = (now() AT TIME ZONE 'UTC')::date
          WHERE id = $1 AND (notify_digest_sent_on IS NULL OR notify_digest_sent_on < (now() AT TIME ZONE 'UTC')::date)
          RETURNING id`,
        [tenantId],
      )).length > 0,
    send: (mail) => sendForcefieldTenantMail(mail),
    track: (event, payload) => trackEventAwait(event, "system", "forcefield", payload),
    baseUrl: instinctPublicBaseUrl(),
    unsubscribeToken: mintUnsubscribeToken,
  };
}
