/**
 * Forcefield-web hostile-signal ALERTING.
 *
 * Detection is only operational if a real attack is SEEN in time. This scans the
 * live agent-inspection stream (site_analytics_events) for the two highest-
 * confidence hostile signals - honeytoken trips and payload attacks - and alerts
 * a person about each INCIDENT: one site + one attack class + one 6-hour window.
 *
 * Dedupe holds per incident and window, never forever. The old key was
 * (kind, fp, site) with fp 'unknown' for almost every event, so the first alert
 * for a site suppressed every later one. Now a second attack in a later window
 * alerts again, and a repeat inside the same window does not.
 *
 * Delivery: the in-app notification (fanoutToTeam -> notify) AND an email to the
 * security owner through Microsoft Graph (sendViaGraph, never Resend). The outcome
 * is recorded on the alert row and as an AWAITED forcefield.web_alert_dispatched
 * event, delivered or failed. A failed delivery is retried on the next scan (up
 * to MAX_ATTEMPTS), never swallowed.
 *
 * Silence check: once a day, if hostile events exist in the last 24h but no
 * alert reached anyone, that silence is itself raised as an alert.
 *
 * Injected deps so the scan is unit-testable with no DB. Never throws into the
 * cron route.
 */
import { createHash } from "node:crypto";
import { safeQuery, query } from "@/lib/db";
import { fanoutToTeam, type TeamFanoutInput } from "@/lib/notifications/team-fanout";
import { sendViaGraph } from "@/lib/mail/send-via-graph";
import { trackEventAwait } from "@/lib/analytics";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";
import { boardHref } from "@/lib/forcefield-web/board-link";
import { isStaticallyGeneric } from "@/lib/forcefield/autoblock-scope";
import { getEdgePolicy, type EdgePolicy } from "@/lib/forcefield/edge-policy";
import { runWithRequestWorkspace } from "@/lib/db/request-workspace";
import {
  renderForcefieldAlertEmail,
  alertSubject,
  alertSummary,
  type BlockDecision,
  type IncidentDetail,
} from "@/lib/forcefield-web/alert-email";

/**
 * Forcefield is still in testing and most of the team does not know it exists,
 * so alerts go to the security owner ONLY, never the whole team. Configurable
 * via env; defaults to the CTO work account. To widen later, set
 * FORCEFIELD_ALERT_RECIPIENT_EMAIL to a comma-separated list.
 */
export function alertRecipientEmails(): string[] {
  return (process.env.FORCEFIELD_ALERT_RECIPIENT_EMAIL || "homyk@thewolfpack.agency")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** One incident = one site + one attack class inside this many hours. */
export const ALERT_WINDOW_HOURS = 6;
/** The silence check looks back this far. */
export const SILENCE_LOOKBACK_HOURS = 24;
/** A failed delivery is retried on later scans until this many attempts. */
export const MAX_ATTEMPTS = 5;

/** autoblock_withheld: an automatic block on a GENERIC fingerprint was recorded
 *  report-only and needs an admin review (see forcefield/autoblock-scope.ts). */
export type ForcefieldWebAlertKind = "honeytoken_trip" | "payload_attack" | "canary_trip" | "alert_silence" | "autoblock_withheld";

export interface HostileSignal {
  kind: "honeytoken_trip" | "payload_attack";
  site: string;
  /** The attack class (sql_injection, xss, ...) or the kind itself for a trap trip. */
  attackClass: string;
  /** ISO start of the 6-hour window the events fell in. */
  windowStart: string;
  /** Distinct NON-EMPTY fingerprints in the window. 0 means no event in the
   *  group recorded one (trap events often carry none), never "zero operators". */
  fpCount: number;
  samplePath: string;
  count: number;
  /** The incident's facts (exact times, paths, source, outcomes). Present on
   *  every live signal; absent only on hand-built test signals. */
  detail?: Omit<IncidentDetail, "blockDecision">;
}

/** A fully formed alert, from any source (scan, silence check, canary trip). */
export interface ForcefieldAlert {
  kind: ForcefieldWebAlertKind;
  /** Stable dedupe key for the incident + window. */
  dedupeKey: string;
  title: string;
  body: string;
  site?: string;
  attackClass?: string;
  windowStart?: string;
  metadata?: Record<string, string | number | boolean>;
  /** Structured incident facts for the email template (scan alerts). */
  incident?: IncidentDetail;
}

export interface DeliveryOutcome {
  status: "delivered" | "failed";
  inAppRecipients: number;
  emailAttempted: number;
  emailDelivered: number;
  /** Short reason when something did not go out (e.g. no_mail_from, scope_missing). */
  detail: string;
}

export interface ForcefieldAlertDeps {
  listHostileSignals: (sinceHours: number) => Promise<HostileSignal[]>;
  /** Claim the dedupe slot. True when the alert should be sent now: a new
   *  incident, or a previous attempt that failed and has attempts left. */
  claimAlert: (alert: ForcefieldAlert) => Promise<boolean>;
  /** Send it (in-app + Graph email). Never throws; reports the outcome. */
  deliver: (alert: ForcefieldAlert) => Promise<DeliveryOutcome>;
  /** Persist the outcome on the alert row. */
  recordOutcome: (alert: ForcefieldAlert, outcome: DeliveryOutcome) => Promise<void>;
  /** Durable (awaited) analytics write. */
  track: (event: "forcefield.web_alert_dispatched" | "forcefield.alert_silence_detected", payload: Record<string, string | number | boolean>) => Promise<void>;
  /** Hostile events in the lookback (silence check). */
  countHostileEvents: (sinceHours: number) => Promise<number>;
  /** Alerts that reached a person in the lookback, silence alerts excluded. */
  countDeliveredAlerts: (sinceHours: number) => Promise<number>;
  /** Optional: add facts only worth reading once the alert is claimed (the
   *  automatic-block decision), so a duplicate costs no extra query. Never
   *  expected to throw; a failure sends the alert unenriched. */
  enrich?: (alert: ForcefieldAlert) => Promise<ForcefieldAlert>;
}

function hashKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/** Start of the fixed window containing `at` (windows are aligned to the epoch). */
export function windowStartOf(at: Date, hours = ALERT_WINDOW_HOURS): string {
  const ms = hours * 3600 * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms).toISOString();
}

/** The dedupe key for one incident: kind + site + attack class + window. */
export function incidentKey(kind: string, site: string, attackClass: string, windowStart: string): string {
  return hashKey([kind, site, attackClass, windowStart]);
}

/** "1 payload attack", "3 payload attacks". */
function countPhrase(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The fingerprint line of an alert. Trap trips and many payload events carry no
 * fingerprint at all, so a count of 0 means "none recorded", not "zero distinct
 * operators": say that plainly instead of printing a misleading 0.
 */
export function fingerprintPhrase(fpCount: number): string {
  if (!Number.isFinite(fpCount) || fpCount <= 0) return "Fingerprint not recorded";
  return `${fpCount} distinct fingerprint${fpCount === 1 ? "" : "s"}`;
}

export function alertFromSignal(s: HostileSignal): ForcefieldAlert {
  const site = s.site || "site";
  const legacyBody =
    `${countPhrase(s.count, s.kind === "honeytoken_trip" ? "honeytoken trip" : "payload attack")} on ${site} (${s.attackClass}). ` +
    `${fingerprintPhrase(s.fpCount)}. Example path: ${s.samplePath || "not recorded"}. ` +
    `This is a high-confidence hostile signal.`;
  const alert: ForcefieldAlert = {
    kind: s.kind,
    dedupeKey: incidentKey(s.kind, s.site, s.attackClass, s.windowStart),
    title: "",
    body: legacyBody,
    site: s.site,
    attackClass: s.attackClass,
    windowStart: s.windowStart,
    metadata: { count: s.count, fp_count: s.fpCount },
    ...(s.detail ? { incident: { ...s.detail } } : {}),
  };
  // Outcome-first subject ("[Forcefield] ogiam.com: hostile agent contained
  // (decoy)"); the plain summary rides the in-app notice and the alert row.
  alert.title = alertSubject(alert);
  if (alert.incident) alert.body = alertSummary(alert);
  return alert;
}

/**
 * Claim, deliver and record ONE alert. The single dispatch path every source
 * (scan, silence check, canary trip) uses. Returns the outcome, or null when the
 * dedupe slot was already taken (a duplicate inside its window). Never throws.
 */
export async function dispatchForcefieldAlert(alert: ForcefieldAlert, deps: Pick<ForcefieldAlertDeps, "claimAlert" | "deliver" | "recordOutcome" | "track" | "enrich">): Promise<DeliveryOutcome | null> {
  let claimed = false;
  try {
    claimed = await deps.claimAlert(alert);
  } catch {
    claimed = false;
  }
  if (!claimed) return null;

  if (deps.enrich) {
    try {
      alert = await deps.enrich(alert);
    } catch {
      /* send unenriched rather than not at all */
    }
  }

  let outcome: DeliveryOutcome;
  try {
    outcome = await deps.deliver(alert);
  } catch (err) {
    outcome = { status: "failed", inAppRecipients: 0, emailAttempted: 0, emailDelivered: 0, detail: `deliver threw: ${(err as Error)?.message ?? "unknown"}`.slice(0, 200) };
  }
  await deps.recordOutcome(alert, outcome).catch(() => {});
  await deps.track("forcefield.web_alert_dispatched", {
    kind: alert.kind,
    fingerprint: alert.dedupeKey,
    site: alert.site ?? "",
    attack_class: alert.attackClass ?? "",
    outcome: outcome.status,
    in_app_recipients: outcome.inAppRecipients,
    email_attempted: outcome.emailAttempted,
    email_delivered: outcome.emailDelivered,
    detail: outcome.detail,
    ...(alert.metadata ?? {}),
  }).catch(() => {});
  return outcome;
}

export interface ScanReport {
  detected: number;
  dispatched: number;
  delivered: number;
  failed: number;
}

export async function scanForcefieldWebAlerts(deps: ForcefieldAlertDeps, sinceHours = SILENCE_LOOKBACK_HOURS): Promise<ScanReport> {
  const signals = await deps.listHostileSignals(sinceHours);
  const report: ScanReport = { detected: signals.length, dispatched: 0, delivered: 0, failed: 0 };
  for (const s of signals) {
    const outcome = await dispatchForcefieldAlert(alertFromSignal(s), deps);
    if (!outcome) continue;
    report.dispatched++;
    if (outcome.status === "delivered") report.delivered++;
    else report.failed++;
  }
  return report;
}

export interface SilenceReport {
  hostileEvents: number;
  deliveredAlerts: number;
  silent: boolean;
  /** The silence alert's delivery outcome, when one was raised this run. */
  alert: DeliveryOutcome | null;
}

/**
 * The silence check: hostile events in the last 24h but zero alerts that reached
 * a person means the alerting path is broken (the bug this replaced was exactly
 * that, silently, for weeks). Raises its own alert, deduped once per UTC day.
 */
export async function runAlertSilenceCheck(deps: ForcefieldAlertDeps, now = new Date()): Promise<SilenceReport> {
  const hostileEvents = await deps.countHostileEvents(SILENCE_LOOKBACK_HOURS).catch(() => 0);
  const deliveredAlerts = await deps.countDeliveredAlerts(SILENCE_LOOKBACK_HOURS).catch(() => 0);
  const silent = hostileEvents > 0 && deliveredAlerts === 0;
  if (!silent) return { hostileEvents, deliveredAlerts, silent, alert: null };

  await deps.track("forcefield.alert_silence_detected", {
    hostile_events: hostileEvents,
    delivered_alerts: deliveredAlerts,
    hours: SILENCE_LOOKBACK_HOURS,
  }).catch(() => {});
  const day = now.toISOString().slice(0, 10);
  const alert = await dispatchForcefieldAlert({
    kind: "alert_silence",
    dedupeKey: hashKey(["alert_silence", day]),
    title: "Forcefield: hostile traffic with no alert delivered",
    body:
      `${hostileEvents} hostile event(s) in the last ${SILENCE_LOOKBACK_HOURS}h but no Forcefield alert reached anyone. ` +
      `The alert scan or its delivery is failing; check the forcefield-alerts cron and the Graph mail settings.`,
    windowStart: `${day}T00:00:00.000Z`,
    metadata: { hostile_events: hostileEvents },
  }, deps);
  return { hostileEvents, deliveredAlerts, silent, alert };
}

/** True when the cron invocation at `now` should run the daily silence check
 *  (the 12:00 UTC hour; the per-day dedupe makes repeats inside it no-ops). */
export function isSilenceCheckHour(now: Date): boolean {
  return now.getUTCHours() === 12;
}

/* ------------------------------ live adapters ----------------------------- */

const HOSTILE_EVENT_TYPES = ["site.agent_trap_tripped", "site.agent_payload_attack"];

/**
 * Our own verification traffic never pages anyone. An event is excluded ONLY when
 * the engine stamped props.synthetic = true, which observe.ts does only when the
 * request presented the x-forcefield-synthetic header matching
 * FORCEFIELD_SYNTHETIC_TOKEN (isSyntheticMonitor, constant-time). A user agent
 * string never exempts anything: it is spoofable, so a probe that only CLAIMS to
 * be ours (e.g. UA wolfpack-verify/1.0) still alerts. The events stay on the
 * board; only the page is suppressed. Applied to the scan AND the silence check,
 * so synthetic-only traffic cannot raise a false "no alert delivered" either.
 */
export const EXCLUDE_SYNTHETIC_SQL = `COALESCE(props->>'synthetic', '') <> 'true'`;

/** The alert row id (same derivation as the dedupe store), shown in the email
 *  footer so a reader can find the row. */
export function alertRowId(alert: Pick<ForcefieldAlert, "kind" | "dedupeKey">): string {
  return hashKey([alert.kind, alert.dedupeKey]);
}

/**
 * In-app (fanoutToTeam) + email (Graph) to the Wolfpack security owner list
 * (alertRecipientEmails) ONLY. Build phase: no client or tenant ever receives a
 * Forcefield alert, and this is the only delivery path (guarded by
 * alert-delivery-guardrail.test.ts). One email per incident, rendered by the
 * shared operator template. Never throws.
 */
export async function deliverForcefieldAlert(alert: ForcefieldAlert): Promise<DeliveryOutcome> {
  const recipients = alertRecipientEmails();
  const email = renderForcefieldAlertEmail(alert, {
    audience: "operator",
    baseUrl: instinctPublicBaseUrl(),
    recipients,
    alertId: alertRowId(alert),
  });
  const fanoutInput: TeamFanoutInput = {
    actor: { id: "system", role: "system", name: "Forcefield" },
    title: email.subject.replace(/^\[Forcefield\]\s*/, "Forcefield: "),
    body: alert.body,
    actionUrl: email.links[0]?.href.replace(instinctPublicBaseUrl(), "") || boardHref({ tab: "forcefield" }),
    actionLabel: "Open on the board",
    category: "security",
    recipientEmails: recipients,
    source: "forcefield-web",
    sourceId: alert.dedupeKey,
    metadata: { kind: alert.kind, site: alert.site ?? "", attack_class: alert.attackClass ?? "", ...(alert.metadata ?? {}) },
    analyticsEvent: "forcefield.web_alert_notified",
    analyticsPayload: { kind: alert.kind, fingerprint: alert.dedupeKey },
  };
  const details: string[] = [];
  let inAppRecipients = 0;
  try {
    inAppRecipients = (await fanoutToTeam(fanoutInput)).recipientCount;
    if (inAppRecipients === 0) details.push("in_app:no_recipient");
  } catch (err) {
    details.push(`in_app:${(err as Error)?.message ?? "error"}`);
  }

  let emailAttempted = 0;
  let emailDelivered = 0;
  for (const to of recipients) {
    emailAttempted++;
    try {
      const res = await sendViaGraph({ to, subject: email.subject, text: email.text, html: email.html, fromName: "OGIAM Forcefield" });
      if (res.delivered) emailDelivered++;
      else details.push(`email:${res.reason}`);
    } catch (err) {
      details.push(`email:${(err as Error)?.message ?? "error"}`);
    }
  }
  const status = inAppRecipients > 0 || emailDelivered > 0 ? "delivered" : "failed";
  return { status, inAppRecipients, emailAttempted, emailDelivered, detail: Array.from(new Set(details)).join(",").slice(0, 200) };
}

/** Dedupe + delivery persistence against instinct_forcefield_web_alerts. */
export function liveAlertStore(): Pick<ForcefieldAlertDeps, "claimAlert" | "recordOutcome" | "countDeliveredAlerts"> {
  return {
    claimAlert: async (alert) => {
      const id = hashKey([alert.kind, alert.dedupeKey]);
      // New incident -> inserted. Same incident already DELIVERED (or out of
      // attempts) -> the WHERE fails, 0 rows, no re-alert. A FAILED attempt with
      // attempts left -> re-claimed so the next scan retries it.
      const res = await query(
        `INSERT INTO instinct_forcefield_web_alerts
           (id, alert_kind, fingerprint, severity, title, body, site, attack_class, window_start)
         VALUES ($1, $2, $3, 'high', $4, $5, $6, $7, $8)
         ON CONFLICT (alert_kind, fingerprint) DO UPDATE
           SET attempts = instinct_forcefield_web_alerts.attempts + 1
         WHERE instinct_forcefield_web_alerts.delivery_status = 'failed'
           AND instinct_forcefield_web_alerts.attempts < $9`,
        [id, alert.kind, alert.dedupeKey, alert.title, alert.body, alert.site ?? null, alert.attackClass ?? null, alert.windowStart ?? null, MAX_ATTEMPTS],
      );
      return (res.rowCount ?? 0) > 0;
    },
    recordOutcome: async (alert, outcome) => {
      await query(
        `UPDATE instinct_forcefield_web_alerts
            SET delivery_status = $3, delivery_detail = $4, dispatched_at = now()
          WHERE alert_kind = $1 AND fingerprint = $2`,
        [alert.kind, alert.dedupeKey, outcome.status, outcome.detail || null],
      );
    },
    countDeliveredAlerts: async (sinceHours) => {
      const { rows } = await safeQuery<{ n: string }>(
        `SELECT count(*) AS n FROM instinct_forcefield_web_alerts
          WHERE delivery_status = 'delivered'
            AND alert_kind <> 'alert_silence'
            AND dispatched_at > now() - ($1 || ' hours')::interval`,
        [String(sinceHours)],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

/** Most distinct values of one attribute the alert carries (the rest are counted). */
export const DETAIL_LIST_CAP = 5;

type SignalRow = {
  kind: string; site: string; attack: string; window_start: string; fps: string; sample: string | null; count: string;
  first_at: string; last_at: string;
  paths: string[] | null; path_count: string;
  countries: string[] | null; hosting: string[] | null; client_types: string[] | null; agents: string[] | null; networks: string[] | null;
  fp_list: string[] | null; sigs: string[] | null; sig_count: string;
  n_blocked: string; n_contained: string; n_recorded: string;
  postures: string[] | null; reason_kinds: string[] | null;
};

/** Map one grouped row to a signal with its full incident detail. Exported for tests. */
export function signalFromRow(r: SignalRow): HostileSignal {
  const kind = r.kind === "site.agent_trap_tripped" ? "honeytoken_trip" : "payload_attack";
  const arr = (a: string[] | null) => (a ?? []).filter((v) => typeof v === "string" && v !== "");
  const capped = (a: string[] | null) => arr(a).slice(0, DETAIL_LIST_CAP);
  const fpAll = arr(r.fp_list);
  const sigAll = arr(r.sigs);
  const windowStart = new Date(r.window_start).toISOString();
  return {
    kind,
    site: r.site,
    attackClass: r.attack === r.kind ? kind : r.attack,
    windowStart,
    fpCount: Number(r.fps),
    samplePath: r.sample ?? "",
    count: Number(r.count),
    detail: {
      firstAt: new Date(r.first_at).toISOString(),
      lastAt: new Date(r.last_at).toISOString(),
      count: Number(r.count),
      windowStart,
      windowHours: ALERT_WINDOW_HOURS,
      paths: capped(r.paths),
      pathCount: Number(r.path_count),
      countries: capped(r.countries),
      hosting: capped(r.hosting),
      clientTypes: capped(r.client_types),
      agents: capped(r.agents),
      networks: capped(r.networks),
      fingerprints: fpAll.slice(0, DETAIL_LIST_CAP),
      fingerprintCount: Number(r.fps),
      signatures: sigAll.slice(0, DETAIL_LIST_CAP),
      signatureCount: Number(r.sig_count),
      outcomes: { blocked: Number(r.n_blocked), contained: Number(r.n_contained), recorded: Number(r.n_recorded) },
      postures: capped(r.postures),
      reasonKinds: capped(r.reason_kinds),
    },
  };
}

/**
 * The automatic-block decision for an incident's fingerprints, read back from
 * what the ingest path RECORDED (never recomputed): an active automatic row in
 * instinct_agent_blocked_fingerprints means blocked; a
 * forcefield.autoblock_withheld_generic event naming the fingerprint since the
 * window start means withheld. Otherwise none. Null on a read error.
 *
 * "blocked" is claimed only for a row the ruleset actually SERVES: a stored
 * automatic row on a statically generic fingerprint is never distributed, and
 * no automatic row is while the edge policy is off enforce + auto_block (same
 * rules as getBlockedFingerprints), so neither is reported as a block.
 */
export async function lookupBlockDecision(
  fps: readonly string[],
  sinceIso: string,
  getPolicy: (workspaceId: string) => Promise<EdgePolicy> = getEdgePolicy,
): Promise<BlockDecision | null> {
  const list = fps.filter(Boolean).slice(0, DETAIL_LIST_CAP);
  if (list.length === 0) return null;
  // Automatic blocks live in the Forcefield edge workspace (the same one
  // autoBlockFingerprint writes and getBlockedFingerprints serves).
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  try {
    const blocked = await runWithRequestWorkspace(workspaceId, () => safeQuery<{ fp: string; expires_at: string | null }>(
      `SELECT fp, max(expires_at)::text AS expires_at FROM instinct_agent_blocked_fingerprints
        WHERE workspace_id = $2 AND fp = ANY($1::text[]) AND operator_key LIKE 'auto:%'
          AND (expires_at IS NULL OR expires_at > now())
        GROUP BY fp`,
      [list, workspaceId],
    ));
    const served = blocked.rows.filter((r) => !isStaticallyGeneric(r.fp));
    if (served.length > 0) {
      const policy = await getPolicy(workspaceId).catch(() => null);
      if (policy && policy.mode === "enforce" && policy.autoBlock) {
        const exp = served.map((r) => r.expires_at).filter((x): x is string => !!x).sort().pop();
        return { state: "blocked", fingerprints: served.map((r) => r.fp), ...(exp ? { expiresAt: new Date(exp).toISOString() } : {}) };
      }
    }
    const withheld = await safeQuery<{ fps: string | null; why: string | null }>(
      `SELECT metadata->>'fps' AS fps, metadata->>'why' AS why FROM instinct_events
        WHERE event_type = 'forcefield.autoblock_withheld_generic'
          AND timestamp >= $1::timestamptz
        ORDER BY timestamp DESC
        LIMIT 50`,
      [sinceIso],
    );
    for (const r of withheld.rows) {
      const named = (r.fps ?? "").split(",").map((f) => f.trim());
      const hit = list.filter((f) => named.includes(f));
      if (hit.length > 0) return { state: "withheld", fingerprints: hit, ...(r.why ? { why: r.why } : {}) };
    }
    return { state: "none", fingerprints: list };
  } catch {
    return null;
  }
}

export function liveForcefieldAlertDeps(): ForcefieldAlertDeps {
  return {
    listHostileSignals: async (sinceHours) => {
      // Group by incident: kind + site + attack class + 6-hour window, so the
      // dedupe key is per incident and window (see the file header). Each group
      // carries its exact first/last times, distinct paths, source and the
      // per-request outcome so the email states facts, not the window.
      const { rows } = await safeQuery<SignalRow>(
        `SELECT event_type AS kind,
                COALESCE(props->>'site', '') AS site,
                COALESCE(NULLIF(props->>'attack', ''), event_type) AS attack,
                to_timestamp(floor(extract(epoch FROM created_at) / ($2::int * 3600)) * ($2::int * 3600)) AS window_start,
                count(DISTINCT NULLIF(props->>'fp', '')) AS fps,
                min(path) AS sample,
                count(*) AS count,
                min(created_at) AS first_at,
                max(created_at) AS last_at,
                (array_agg(DISTINCT path) FILTER (WHERE path IS NOT NULL AND path <> ''))[1:${DETAIL_LIST_CAP}] AS paths,
                count(DISTINCT NULLIF(path, '')) AS path_count,
                array_agg(DISTINCT country) FILTER (WHERE country IS NOT NULL AND country <> '') AS countries,
                array_agg(DISTINCT props->>'hosting') FILTER (WHERE COALESCE(props->>'hosting', '') <> '') AS hosting,
                array_agg(DISTINCT props->>'client_type') FILTER (WHERE COALESCE(props->>'client_type', '') <> '') AS client_types,
                array_agg(DISTINCT props->>'agent') FILTER (WHERE COALESCE(props->>'agent', '') <> '') AS agents,
                array_agg(DISTINCT COALESCE(NULLIF(props->>'org', ''), NULLIF(props->>'asn', ''))) FILTER (WHERE COALESCE(props->>'org', props->>'asn', '') <> '') AS networks,
                (array_agg(DISTINCT props->>'fp') FILTER (WHERE COALESCE(props->>'fp', '') <> ''))[1:${DETAIL_LIST_CAP}] AS fp_list,
                (array_agg(DISTINCT props->>'sig') FILTER (WHERE COALESCE(props->>'sig', '') <> ''))[1:${DETAIL_LIST_CAP}] AS sigs,
                count(DISTINCT NULLIF(props->>'sig', '')) AS sig_count,
                count(*) FILTER (WHERE props->>'blocked' = 'true') AS n_blocked,
                count(*) FILTER (WHERE COALESCE(props->>'blocked', '') <> 'true' AND (props->>'tarpit' = 'true' OR props->>'action' = 'tarpit')) AS n_contained,
                count(*) FILTER (WHERE COALESCE(props->>'blocked', '') <> 'true' AND COALESCE(props->>'tarpit', '') <> 'true' AND COALESCE(props->>'action', '') <> 'tarpit') AS n_recorded,
                array_agg(DISTINCT props->>'posture') FILTER (WHERE COALESCE(props->>'posture', '') <> '') AS postures,
                array_agg(DISTINCT props->>'reason_kind') FILTER (WHERE COALESCE(props->>'reason_kind', '') <> '') AS reason_kinds
           FROM site_analytics_events
          WHERE event_type = ANY($3::text[])
            AND created_at > now() - ($1 || ' hours')::interval
            AND ${EXCLUDE_SYNTHETIC_SQL}
          GROUP BY 1, 2, 3, 4`,
        [String(sinceHours), ALERT_WINDOW_HOURS, HOSTILE_EVENT_TYPES],
      );
      return rows.map(signalFromRow);
    },
    // One email per incident: the automatic-block decision the ingest path
    // recorded for a trap trip is folded INTO the incident email (the ingest
    // path no longer sends its own notice for it).
    enrich: async (alert) => {
      const i = alert.incident;
      if (alert.kind !== "honeytoken_trip" || !i || i.fingerprints.length === 0) return alert;
      const decision = await lookupBlockDecision(i.fingerprints, i.windowStart);
      return decision ? { ...alert, incident: { ...i, blockDecision: decision } } : alert;
    },
    ...liveAlertStore(),
    deliver: deliverForcefieldAlert,
    track: (event, payload) => trackEventAwait(event, "system", "forcefield", payload),
    countHostileEvents: async (sinceHours) => {
      const { rows } = await safeQuery<{ n: string }>(
        `SELECT count(*) AS n FROM site_analytics_events
          WHERE event_type = ANY($2::text[])
            AND created_at > now() - ($1 || ' hours')::interval
            AND ${EXCLUDE_SYNTHETIC_SQL}`,
        [String(sinceHours), HOSTILE_EVENT_TYPES],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}
