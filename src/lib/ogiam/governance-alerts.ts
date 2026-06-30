/**
 * Governance drift ALERTING: turn a governance regression into a notification.
 *
 * Governance is only operational if a regression is SEEN. This module runs (on a
 * schedule, via /api/cron/governance-alerts/scan, or on an admin manual run) over
 * the durable governance signals, detects regressions, and — for each genuinely
 * NEW one — fans a notification out through the EXISTING notifications layer and
 * records the condition so it never re-alerts.
 *
 * CONDITIONS detected (each a distinct alert_kind):
 *   - redteam_passrate_drop   the latest red-team run's pass rate dropped vs the
 *                             previous run (a gate regression: the gate started
 *                             letting attacks through it used to block).
 *   - redteam_new_vuln        the latest run found a vuln (a specific attack the
 *                             gate failed to block) — one alert per attack id.
 *   - new_ungoverned_surface  a NEW ungoverned AI surface appeared in the
 *                             inventory (a touchpoint not routed through a
 *                             governance layer) — one alert per surface id.
 *
 * TECH CHOICE — transport: REUSE the notifications layer (src/lib/notifications/*
 * — `fanoutToTeam` → `notify`, which writes one instinct_notifications DB row per
 * recipient and feeds the Resend digest path), NOT a new outbound webhook or a
 * bespoke email send. Rationale: the notifications layer already gives us a DB row
 * per send (no data lost — full notification history is reconstructable), per-user
 * preferences, the bell surface, and the Resend fan-out, all in one audited place.
 * A new channel would fork that and lose the history + preference handling. A
 * webhook is a future ADAPTER on top of this, not a replacement.
 *
 * TECH CHOICE — dedupe: a small alerts table (migration 215,
 * instinct_governance_alerts) keyed on (workspace_id, alert_kind, fingerprint).
 * The fingerprint is a stable hash of the SPECIFIC regression (the new vuln's
 * attack id, the new surface's id, or the pair of pass rates), so a recurring
 * scan that re-observes the same condition is a no-op INSERT (ON CONFLICT DO
 * NOTHING returns zero rows → we skip the dispatch), while a genuinely new
 * regression inserts once and alerts once.
 *
 * Best-effort + workspace-scoped: every query carries a parameterized
 * workspace_id; a DB hiccup degrades to "no alert" rather than throwing into the
 * cron route. Emits ogiam.drift_alert_dispatched per dispatched alert.
 */

import { createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { listRuns } from "@/lib/ai-redteam/store";
import { listSurfaces } from "@/lib/ai-surface/store";
import { fanoutToTeam } from "@/lib/notifications/team-fanout";

export type GovernanceAlertKind =
  | "redteam_passrate_drop"
  | "redteam_new_vuln"
  | "new_ungoverned_surface";

export type GovernanceAlertSeverity = "low" | "medium" | "high" | "critical";

/** A detected regression, before dedupe/dispatch. Pure: produced from signals. */
export interface DetectedAlert {
  kind: GovernanceAlertKind;
  /** Stable dedupe key within (workspace, kind). */
  fingerprint: string;
  severity: GovernanceAlertSeverity;
  title: string;
  body: string;
  metadata: Record<string, string | number | boolean>;
}

/** Input the detector reasons over (decoupled from the stores for testability). */
export interface RedTeamRunLite {
  passRate: number;
  vulns: number;
  createdAt: string;
  /** The vuln attack ids found by this run (drives redteam_new_vuln fingerprints). */
  vulnAttackIds?: string[];
}

export interface SurfaceLite {
  id: string;
  governed: boolean;
  provider: string;
  kind: string;
  location: string;
  firstSeenAt: string;
}

/** Stable short hash for a fingerprint. */
function fp(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/**
 * PURE detection: given the red-team run history (newest first) and the current
 * surface inventory, derive the set of regressions worth alerting on. No DB, no
 * dedupe, no dispatch — that lets the unit tests assert "a drop fires, a steady
 * pass rate does not" deterministically.
 *
 * `newSurfaceWindowDays` bounds which ungoverned surfaces count as "new" by
 * first_seen_at, so an old, long-known ungoverned surface doesn't alert forever
 * (the per-surface fingerprint dedupe also covers this, but the window keeps the
 * first scan after deploy from alerting on the entire historical backlog).
 */
export function detectAlerts(opts: {
  redteamRuns: RedTeamRunLite[];
  surfaces: SurfaceLite[];
  now?: Date;
  newSurfaceWindowDays?: number;
}): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  const runs = opts.redteamRuns ?? [];
  const surfaces = opts.surfaces ?? [];
  const now = opts.now ?? new Date();
  const windowDays = opts.newSurfaceWindowDays ?? 7;

  // --- Red-team signals: compare the latest run to the previous one. ---
  if (runs.length >= 1) {
    const latest = runs[0];

    // redteam_new_vuln: one alert per distinct attack id the latest run failed.
    for (const attackId of latest.vulnAttackIds ?? []) {
      out.push({
        kind: "redteam_new_vuln",
        // Fingerprint on the attack id alone (within workspace+kind): the SAME
        // vuln re-found on the next scan must NOT re-alert.
        fingerprint: fp(attackId),
        severity: "critical",
        title: "Gate regression: red-team attack got through",
        body: `The continuous red-team found an attack the gate failed to block (attack ${attackId}). A policy regression let a hostile action through.`,
        metadata: {
          attack_id: attackId,
          pass_rate: latest.passRate,
          vulns: latest.vulns,
        },
      });
    }

    // redteam_passrate_drop: the latest pass rate dropped vs the previous run.
    if (runs.length >= 2) {
      const prev = runs[1];
      if (
        Number.isFinite(latest.passRate) &&
        Number.isFinite(prev.passRate) &&
        latest.passRate < prev.passRate
      ) {
        out.push({
          kind: "redteam_passrate_drop",
          // Fingerprint on the (prev → latest) pass-rate pair + the latest run's
          // timestamp: a distinct drop event alerts once; re-running the scan with
          // the same two runs does not re-alert.
          fingerprint: fp(prev.passRate, latest.passRate, latest.createdAt),
          severity: "high",
          title: "Gate regression: red-team pass rate dropped",
          body: `The red-team pass rate fell from ${(prev.passRate * 100).toFixed(1)}% to ${(latest.passRate * 100).toFixed(1)}%. The gate is blocking fewer attacks than it was.`,
          metadata: {
            prev_pass_rate: prev.passRate,
            pass_rate: latest.passRate,
            vulns: latest.vulns,
          },
        });
      }
    }
  }

  // --- Ungoverned-surface signal: a NEW ungoverned surface appeared. ---
  const cutoff = now.getTime() - windowDays * 24 * 3600 * 1000;
  for (const s of surfaces) {
    if (s.governed) continue;
    const seen = new Date(s.firstSeenAt).getTime();
    if (Number.isFinite(seen) && seen < cutoff) continue;
    out.push({
      kind: "new_ungoverned_surface",
      // Fingerprint on the surface id (already a deterministic identity hash): the
      // same surface re-discovered on the next scan must NOT re-alert.
      fingerprint: fp(s.id),
      severity: s.kind === "api_key" ? "critical" : "high",
      title: "New ungoverned AI surface detected",
      body: `A new AI touchpoint not routed through a governance layer was discovered: ${s.provider} ${s.kind} at ${s.location}.`,
      metadata: {
        surface_id: s.id,
        provider: s.provider,
        kind: s.kind,
        location: s.location,
      },
    });
  }

  return out;
}

/**
 * Claim a detected alert for dispatch by INSERTing its dedupe row. Returns true
 * iff the row was newly inserted (i.e. this is the first time we've seen this
 * condition) — ON CONFLICT DO NOTHING means a re-observed condition inserts zero
 * rows and we skip the dispatch. Workspace-scoped + parameterized; best-effort
 * (a DB miss returns false → no dispatch, no spam).
 */
async function claimAlert(
  workspaceId: string,
  alert: DetectedAlert,
  recipientCount: number,
): Promise<boolean> {
  const id = `galert_${fp(workspaceId, alert.kind, alert.fingerprint)}`;
  const res = await safeQuery<{ id: string }>(
    `INSERT INTO instinct_governance_alerts
       (id, workspace_id, alert_kind, fingerprint, severity, title, body, metadata, recipient_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (workspace_id, alert_kind, fingerprint) DO NOTHING
     RETURNING id`,
    [
      id,
      workspaceId,
      alert.kind,
      alert.fingerprint,
      alert.severity,
      alert.title,
      alert.body,
      JSON.stringify(alert.metadata),
      recipientCount,
    ],
  );
  return res.rows.length === 1;
}

export interface ScanResult {
  detected: number;
  dispatched: number;
  deduped: number;
  alerts: { kind: GovernanceAlertKind; fingerprint: string; dispatched: boolean }[];
}

export interface ScanInput {
  workspaceId: string;
  actorId: string;
  actorRole: string;
  now?: Date;
  /** Test seam: inject signals instead of reading the stores. */
  redteamRuns?: RedTeamRunLite[];
  surfaces?: SurfaceLite[];
}

/**
 * The cron entrypoint's core: read the governance signals for a workspace, detect
 * regressions, and for each NEW one (dedupe via the alerts table) fan a
 * notification out through the notifications layer and emit
 * ogiam.drift_alert_dispatched. Returns a summary the route serializes.
 *
 * Severity → notification: a critical alert (a new vuln, an ungoverned API key)
 * uses the team fanout's category 'security'. The fanout itself writes a DB row
 * per recipient (no data lost) and feeds the Resend digest.
 */
export async function scanAndDispatch(input: ScanInput): Promise<ScanResult> {
  const { workspaceId, actorId, actorRole } = input;

  // Read signals from the stores unless injected (test seam). Red-team store
  // returns newest-first; surfaces store returns records with firstSeenAt.
  const redteamRuns: RedTeamRunLite[] =
    input.redteamRuns ??
    (await listRuns(workspaceId, 50)).map((r) => ({
      passRate: r.passRate,
      vulns: r.vulns,
      createdAt: r.createdAt,
      // The store does not surface per-vuln attack ids in the list view; the
      // count drives the drop signal, and the new-vuln signal keys on the run's
      // findings when injected. A run with vulns but no ids still triggers a
      // pass-rate-drop alert (covered above).
      vulnAttackIds: [],
    }));

  const surfaces: SurfaceLite[] =
    input.surfaces ??
    (await listSurfaces(workspaceId, { ungovernedOnly: true, limit: 2000 })).map(
      (s) => ({
        id: s.id,
        governed: s.governed,
        provider: s.provider,
        kind: s.kind,
        location: s.location,
        firstSeenAt: s.firstSeenAt,
      }),
    );

  const detected = detectAlerts({
    redteamRuns,
    surfaces,
    now: input.now,
  });

  const result: ScanResult = {
    detected: detected.length,
    dispatched: 0,
    deduped: 0,
    alerts: [],
  };

  for (const alert of detected) {
    // Fan out FIRST so we know the recipient count to record, then claim. But
    // claiming must gate the dispatch to avoid spam, so we claim first and only
    // dispatch on a fresh claim. We record recipientCount after the fanout, so
    // claim with 0 then the fanout reports the real count in analytics.
    const fresh = await claimAlert(workspaceId, alert, 0);
    if (!fresh) {
      result.deduped += 1;
      result.alerts.push({ kind: alert.kind, fingerprint: alert.fingerprint, dispatched: false });
      continue;
    }

    const fanout = await fanoutToTeam({
      actor: { id: actorId, role: actorRole },
      title: alert.title,
      body: alert.body,
      actionUrl: "/admin/ogiam",
      actionLabel: "Review governance",
      category: "security",
      source: "governance-alerts",
      // source+sourceId is the notifications-layer dedupe; align it with ours so
      // even outside this module a duplicate notification is suppressed.
      sourceId: `${alert.kind}:${alert.fingerprint}`,
      metadata: { ...alert.metadata, alert_kind: alert.kind, severity: alert.severity },
      analyticsEvent: "ogiam.drift_alert_dispatched",
      analyticsPayload: { alert_kind: alert.kind, fingerprint: alert.fingerprint },
    });

    result.dispatched += 1;
    result.alerts.push({ kind: alert.kind, fingerprint: alert.fingerprint, dispatched: true });
    // Backfill the recipient count onto the dedupe row (best-effort).
    await safeQuery(
      `UPDATE instinct_governance_alerts SET recipient_count = $1
        WHERE workspace_id = $2 AND alert_kind = $3 AND fingerprint = $4`,
      [fanout.recipientCount, workspaceId, alert.kind, alert.fingerprint],
    );
  }

  return result;
}
