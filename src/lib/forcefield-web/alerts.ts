/**
 * Forcefield-web hostile-signal ALERTING.
 *
 * Detection is only operational if a real attack is SEEN in time. This scans the
 * live agent-inspection stream (site_analytics_events) for the two highest-
 * confidence hostile signals - honeytoken trips and payload attacks - and, for
 * each genuinely NEW hostile fingerprint, fans a notification to the team through
 * the EXISTING notifications layer (fanoutToTeam -> notify), then records it so a
 * recurring scan never re-alerts. Same pattern as ogiam/governance-alerts.
 *
 * Injected deps so the scan is unit-testable with no DB. Best-effort + never
 * throws into the cron route. Emits forcefield.web_alert_dispatched per dispatch.
 */
import { createHash } from "node:crypto";
import { safeQuery, query } from "@/lib/db";
import { fanoutToTeam, type TeamFanoutInput } from "@/lib/notifications/team-fanout";

/**
 * Forcefield is still in testing and most of the team does not know it exists,
 * so alerts go to the security owner ONLY, never the whole team. Configurable
 * via env; defaults to the CTO work account. To widen later, set
 * FORCEFIELD_ALERT_RECIPIENT_EMAIL to a comma-separated list.
 */
const ALERT_RECIPIENT_EMAILS = (process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL || "homyk@thewolfpack.agency")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

export type ForcefieldWebAlertKind = "honeytoken_trip" | "payload_attack";

export interface HostileSignal {
  kind: ForcefieldWebAlertKind;
  fp: string;
  site: string;
  samplePath: string;
  count: number;
}

export interface ForcefieldAlertDeps {
  listHostileSignals: (sinceHours: number) => Promise<HostileSignal[]>;
  /** Returns true when the alert is NEW (inserted), false when already seen. */
  insertAlert: (kind: ForcefieldWebAlertKind, fingerprint: string, title: string, body: string) => Promise<boolean>;
  fanout: (input: TeamFanoutInput) => Promise<void>;
}

function fingerprintOf(kind: string, fp: string, site: string): string {
  return createHash("sha256").update([kind, fp, site].join("|")).digest("hex").slice(0, 24);
}

export async function scanForcefieldWebAlerts(deps: ForcefieldAlertDeps, sinceHours = 24): Promise<{ detected: number; dispatched: number }> {
  const signals = await deps.listHostileSignals(sinceHours);
  let dispatched = 0;
  for (const s of signals) {
    const fingerprint = fingerprintOf(s.kind, s.fp, s.site);
    const title = s.kind === "honeytoken_trip"
      ? `Forcefield: honeytoken tripped on ${s.site || "site"}`
      : `Forcefield: payload attack on ${s.site || "site"}`;
    const body = `${s.count} ${s.kind.replace("_", " ")} event(s) from fingerprint ${s.fp}, e.g. ${s.samplePath}. This is a high-confidence hostile signal.`;
    const isNew = await deps.insertAlert(s.kind, fingerprint, title, body).catch(() => false);
    if (!isNew) continue;
    await deps.fanout({
      actor: { id: "system", role: "system", name: "Forcefield" },
      title,
      body,
      actionUrl: "/admin/forcefield-web",
      actionLabel: "Open Forcefield",
      category: "security",
      recipientEmails: ALERT_RECIPIENT_EMAILS,
      source: "forcefield-web",
      sourceId: fingerprint,
      metadata: { kind: s.kind, fp: s.fp, site: s.site, count: s.count },
      analyticsEvent: "forcefield.web_alert_dispatched",
      analyticsPayload: { kind: s.kind, fingerprint, count: s.count },
    }).catch(() => {});
    dispatched++;
  }
  return { detected: signals.length, dispatched };
}

export function liveForcefieldAlertDeps(): ForcefieldAlertDeps {
  return {
    listHostileSignals: async (sinceHours) => {
      const { rows } = await safeQuery<{ kind: string; fp: string; site: string; sample: string | null; count: string }>(
        `SELECT event_type AS kind,
                COALESCE(props->>'fp', 'unknown') AS fp,
                COALESCE(props->>'site', '') AS site,
                min(path) AS sample,
                count(*) AS count
           FROM site_analytics_events
          WHERE event_type IN ('site.agent_trap_tripped', 'site.agent_payload_attack')
            AND created_at > now() - ($1 || ' hours')::interval
          GROUP BY 1, 2, 3`,
        [String(sinceHours)],
      );
      return rows.map((r) => ({
        kind: r.kind === "site.agent_trap_tripped" ? "honeytoken_trip" : "payload_attack",
        fp: r.fp,
        site: r.site,
        samplePath: r.sample ?? "",
        count: Number(r.count),
      }));
    },
    insertAlert: async (kind, fingerprint, title, body) => {
      const id = createHash("sha256").update(`${kind}:${fingerprint}`).digest("hex").slice(0, 24);
      const res = await query(
        `INSERT INTO instinct_forcefield_web_alerts (id, alert_kind, fingerprint, severity, title, body)
         VALUES ($1, $2, $3, 'high', $4, $5)
         ON CONFLICT (alert_kind, fingerprint) DO NOTHING`,
        [id, kind, fingerprint, title, body],
      );
      return (res.rowCount ?? 0) > 0;
    },
    fanout: async (input) => { await fanoutToTeam(input); },
  };
}
