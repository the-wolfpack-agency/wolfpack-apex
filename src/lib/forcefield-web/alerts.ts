/**
 * Forcefield-web hostile-signal ALERTING.
 *
 * Detection is only operational if a real attack is SEEN in time, and an alert
 * is only useful if it is not drowned in routine noise. This scans the live
 * agent-inspection stream (site_analytics_events) for the two highest-
 * confidence hostile signals, trap trips and payload attacks, groups them into
 * INCIDENTS (one site + one source burst + one 6-hour window, every attack class
 * in the burst together; see incidents.ts) and routes each one by severity:
 *
 *   - IMMEDIATE email: the incident needs attention. A decoy / honeytoken trip,
 *     or any request that was recorded but NOT stopped (watch / report-only).
 *     One email per incident, listing every attack class and its count.
 *   - DAILY DIGEST: every request was blocked or contained. One email a day
 *     (first scan at or after 08:00 US Eastern) summarizing every such incident
 *     in the period, per site. Skipped when there is nothing to report.
 *
 * Dedupe holds per incident and window (immediate) and per Eastern date
 * (digest), in the same store (instinct_forcefield_web_alerts). Digest periods
 * partition time on window boundaries, so every blocked incident lands in
 * exactly one digest; a failed or missed digest's period rolls into the next.
 *
 * Delivery: the in-app notification (fanoutToTeam -> notify) AND an email to the
 * security owner through Microsoft Graph (sendViaGraph, never Resend). The outcome
 * is recorded on the alert row and as an AWAITED forcefield.web_alert_dispatched
 * event, delivered or failed. A failed delivery is retried on the next scan (up
 * to MAX_ATTEMPTS), never swallowed.
 *
 * Silence check: once a day, if an incident needing attention arrived in the
 * last 24h but no immediate alert reached anyone, or blocked traffic arrived but
 * the day's digest did not go out, that silence is itself raised as an alert.
 *
 * Injected deps so the scan is unit-testable with no DB. Never throws into the
 * cron route.
 */
import { createHash } from "node:crypto";
import { isRecipientAllowed } from "@/lib/forcefield-web/recipient-allowlist";
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
import {
  buildIncidents,
  buildDigest,
  digestPeriod,
  digestResumeFrom,
  INCIDENT_WINDOW_HOURS,
  LIST_CAP,
  type AttentionReason,
  type ClassLine,
  type DigestData,
  type EventOutcome,
  type HostileEventGroup,
  type HostileIncident,
} from "@/lib/forcefield-web/incidents";

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
    .filter(Boolean)
    // Build-phase rule: even the operator list can only reach the recipient
    // allowlist (FORCEFIELD_RECIPIENT_DOMAINS, recipient-allowlist.ts).
    .filter((e) => isRecipientAllowed(e));
}

/** One incident = one site + one source burst inside this many hours. */
export const ALERT_WINDOW_HOURS = INCIDENT_WINDOW_HOURS;
/** The scan and the silence check look back this far. */
export const SILENCE_LOOKBACK_HOURS = 24;
/** A failed delivery is retried on later scans until this many attempts. */
export const MAX_ATTEMPTS = 5;

/** autoblock_withheld: an automatic block on a GENERIC fingerprint was recorded
 *  report-only and needs an admin review (see forcefield/autoblock-scope.ts).
 *  hostile_incident: a grouped incident that needs attention (immediate).
 *  alert_digest: the once-a-day digest of blocked incidents. */
export type ForcefieldWebAlertKind =
  | "honeytoken_trip"
  | "payload_attack"
  | "hostile_incident"
  | "alert_digest"
  | "canary_trip"
  | "alert_silence"
  | "autoblock_withheld";

/**
 * One site + one attack class + one window, the pre-grouping shape. Kept for
 * hand-built alerts (previews, fixtures, tests); the live scan builds
 * hostile_incident alerts from incidents.ts instead.
 */
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
  /** The incident's facts (exact times, paths, source, outcomes). */
  detail?: Omit<IncidentDetail, "blockDecision">;
}

/** A fully formed alert, from any source (scan, digest, silence check, canary trip). */
export interface ForcefieldAlert {
  kind: ForcefieldWebAlertKind;
  /** Stable dedupe key for the incident + window (or the digest's date). */
  dedupeKey: string;
  title: string;
  body: string;
  /** The internal site label (store + board filter); emails show its hostname. */
  site?: string;
  attackClass?: string;
  windowStart?: string;
  metadata?: Record<string, string | number | boolean>;
  /** Structured incident facts for the email template (scan alerts). */
  incident?: IncidentDetail;
  /** hostile_incident: every attack class in the burst, most requests first. */
  classes?: ClassLine[];
  /** hostile_incident: why it was sent immediately. */
  attention?: AttentionReason[];
  /** alert_digest: the digest content. */
  digest?: DigestData;
}

export interface DeliveryOutcome {
  status: "delivered" | "failed";
  inAppRecipients: number;
  emailAttempted: number;
  emailDelivered: number;
  /** Short reason when something did not go out (e.g. no_mail_from, scope_missing). */
  detail: string;
}

/** Status of a digest row: delivered / failed, or empty (nothing to report). */
export type DigestRowStatus = "delivered" | "failed" | "empty" | null;

type TrackedEvent = "forcefield.web_alert_dispatched" | "forcefield.alert_silence_detected" | "forcefield.alert_digest_built";

export interface ForcefieldAlertDeps {
  /** Hostile events with created_at in [sinceIso, untilIso), synthetic
   *  excluded, collapsed into groups of identical facts (exact counts). Throws on
   *  a read error so a failed read is never mistaken for a quiet day. */
  listHostileEvents: (sinceIso: string, untilIso: string) => Promise<HostileEventGroup[]>;
  /** Claim the dedupe slot. True when the alert should be sent now: a new
   *  incident, or a previous attempt that failed and has attempts left. */
  claimAlert: (alert: ForcefieldAlert) => Promise<boolean>;
  /** Send it (in-app + Graph email). Never throws; reports the outcome. */
  deliver: (alert: ForcefieldAlert) => Promise<DeliveryOutcome>;
  /** Persist the outcome on the alert row. */
  recordOutcome: (alert: ForcefieldAlert, outcome: DeliveryOutcome) => Promise<void>;
  /** Mark a claimed digest as handled with nothing to report. */
  recordDigestEmpty: (alert: ForcefieldAlert) => Promise<void>;
  /** Where coverage resumes for a digest ending at `beforeIso`: the end of the
   *  latest handled (delivered or empty) digest, else the start of the earliest
   *  claimed-but-unhandled one (see digestResumeFrom); null with no history. */
  digestResumeFrom: (beforeIso: string) => Promise<Date | null>;
  /** The status of the digest row for one Eastern date (silence check). */
  digestStatus: (dedupeKey: string) => Promise<DigestRowStatus>;
  /** Durable (awaited) analytics write. */
  track: (event: TrackedEvent, payload: Record<string, string | number | boolean>) => Promise<void>;
  /** Events that need attention (trap trips, or not stopped) in the lookback. */
  countAttentionEvents: (sinceHours: number) => Promise<number>;
  /** Hostile events (any outcome) with created_at in [sinceIso, untilIso). */
  countHostileEventsBetween: (sinceIso: string, untilIso: string) => Promise<number>;
  /** Immediate alerts that reached a person in the lookback (silence and
   *  digest rows excluded). */
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

/** The dedupe key for one incident: kind + site + identity + window. */
export function incidentKey(kind: string, site: string, identity: string, windowStart: string): string {
  return hashKey([kind, site, identity, windowStart]);
}

/** The dedupe key of the digest for one US Eastern date. */
export function digestKey(etDate: string): string {
  return hashKey(["alert_digest", etDate]);
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
  alert.title = alertSubject(alert);
  if (alert.incident) alert.body = alertSummary(alert);
  return alert;
}

/** The immediate alert for one grouped incident (one email, every class). */
export function alertFromIncident(inc: HostileIncident): ForcefieldAlert {
  const alert: ForcefieldAlert = {
    kind: "hostile_incident",
    dedupeKey: incidentKey("hostile_incident", inc.site, inc.anchor, inc.windowStart),
    title: "",
    body: "",
    site: inc.site,
    attackClass: inc.classes[0]?.attackClass ?? "",
    windowStart: inc.windowStart,
    metadata: {
      count: inc.detail.count,
      classes: inc.classes.length,
      attack_classes: inc.classes.map((c) => c.attackClass).join(",").slice(0, 200),
      attention: inc.attention.join(","),
      fp_count: inc.detail.fingerprintCount,
      blocked: inc.detail.outcomes.blocked,
      contained: inc.detail.outcomes.contained,
      not_blocked: inc.detail.outcomes.recorded,
    },
    incident: { ...inc.detail },
    classes: inc.classes,
    attention: inc.attention,
  };
  alert.title = alertSubject(alert);
  alert.body = alertSummary(alert);
  return alert;
}

/** Deliver, record and track an alert whose dedupe slot is already claimed. */
async function sendClaimed(alert: ForcefieldAlert, deps: Pick<ForcefieldAlertDeps, "deliver" | "recordOutcome" | "track" | "enrich">): Promise<DeliveryOutcome> {
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
  return sendClaimed(alert, deps);
}

export interface ScanReport {
  /** Incidents in the lookback. */
  detected: number;
  /** Of those, how many need attention (routed to an immediate email). */
  immediate: number;
  /** Of those, how many were fully blocked (left for the daily digest). */
  digestOnly: number;
  dispatched: number;
  delivered: number;
  failed: number;
}

/** The immediate-alert scan: every incident in the lookback (window-aligned so
 *  the earliest window is whole), routed; only immediate incidents send. */
export async function scanForcefieldWebAlerts(deps: ForcefieldAlertDeps, now = new Date(), sinceHours = SILENCE_LOOKBACK_HOURS): Promise<ScanReport> {
  const since = windowStartOf(new Date(now.getTime() - sinceHours * 3600_000));
  const incidents = buildIncidents(await deps.listHostileEvents(since, new Date(now.getTime() + 1).toISOString()));
  const immediate = incidents.filter((i) => i.route === "immediate");
  const report: ScanReport = { detected: incidents.length, immediate: immediate.length, digestOnly: incidents.length - immediate.length, dispatched: 0, delivered: 0, failed: 0 };
  for (const inc of immediate) {
    const outcome = await dispatchForcefieldAlert(alertFromIncident(inc), deps);
    if (!outcome) continue;
    report.dispatched++;
    if (outcome.status === "delivered") report.delivered++;
    else report.failed++;
  }
  return report;
}

export interface DigestReport {
  /** False before the digest hour (US Eastern). */
  due: boolean;
  /** False when today's digest was already handled (or is in flight). */
  claimed: boolean;
  etDate?: string;
  periodStart?: string;
  periodEnd?: string;
  incidents: number;
  attempts: number;
  /** sent | empty (nothing to report) | failed | skipped (not due / not claimed). */
  outcome: "sent" | "empty" | "failed" | "skipped";
}

/**
 * The once-a-day digest of blocked incidents. Runs on every scan; does work
 * only on the first scan at or after DIGEST_HOUR_ET each Eastern date (the
 * per-date dedupe row is the claim, so it cannot double-send) and retries a
 * failed send on later scans. Never throws.
 */
export async function runDailyDigest(deps: ForcefieldAlertDeps, now = new Date()): Promise<DigestReport> {
  const skipped: DigestReport = { due: false, claimed: false, incidents: 0, attempts: 0, outcome: "skipped" };
  const probe = digestPeriod(now, null);
  if (!probe) return skipped;
  const lastEnd = await deps.digestResumeFrom(probe.end.toISOString()).catch(() => null);
  const period = digestPeriod(now, lastEnd)!;
  const base = { due: true, etDate: period.etDate, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString() };
  const alert: ForcefieldAlert = {
    kind: "alert_digest",
    dedupeKey: digestKey(period.etDate),
    title: `Forcefield daily digest ${period.etDate}`,
    body: `Blocked incidents with windows from ${base.periodStart} to ${base.periodEnd}.`,
    // The row's window_start is the period END: the next digest starts there.
    windowStart: base.periodEnd,
  };
  let claimed = false;
  try {
    claimed = await deps.claimAlert(alert);
  } catch {
    claimed = false;
  }
  if (!claimed) return { ...skipped, ...base, due: true };

  const built = (outcome: DigestReport["outcome"], d?: DigestData) =>
    deps.track("forcefield.alert_digest_built", {
      et_date: period.etDate,
      period_start: base.periodStart,
      period_end: base.periodEnd,
      incidents: d?.totals.incidents ?? 0,
      attempts: d?.totals.attempts ?? 0,
      sites: d?.totals.sites ?? 0,
      immediate_incidents: d?.immediateIncidents ?? 0,
      outcome,
    }).catch(() => {});

  let digest: DigestData;
  try {
    digest = buildDigest(buildIncidents(await deps.listHostileEvents(base.periodStart, base.periodEnd)), period);
  } catch (err) {
    // A failed read is a failed digest (retried), never an empty one.
    const outcome: DeliveryOutcome = { status: "failed", inAppRecipients: 0, emailAttempted: 0, emailDelivered: 0, detail: `list_failed: ${(err as Error)?.message ?? "unknown"}`.slice(0, 200) };
    await deps.recordOutcome(alert, outcome).catch(() => {});
    await built("failed");
    return { ...base, claimed: true, incidents: 0, attempts: 0, outcome: "failed" };
  }
  if (digest.totals.incidents === 0) {
    await deps.recordDigestEmpty(alert).catch(() => {});
    await built("empty", digest);
    return { ...base, claimed: true, incidents: 0, attempts: 0, outcome: "empty" };
  }
  alert.digest = digest;
  alert.metadata = { incidents: digest.totals.incidents, attempts: digest.totals.attempts, sites: digest.totals.sites, immediate_incidents: digest.immediateIncidents, period_start: base.periodStart, period_end: base.periodEnd };
  alert.title = alertSubject(alert);
  alert.body = alertSummary(alert);
  const outcome = await sendClaimed(alert, deps);
  const result = outcome.status === "delivered" ? "sent" : "failed";
  await built(result, digest);
  return { ...base, claimed: true, incidents: digest.totals.incidents, attempts: digest.totals.attempts, outcome: result };
}

export interface SilenceReport {
  /** Events needing attention in the last 24h. */
  hostileEvents: number;
  /** Immediate alerts that reached a person in the last 24h. */
  deliveredAlerts: number;
  /** Hostile events in today's digest period, and that digest's status. */
  digestEvents: number;
  digestStatus: DigestRowStatus;
  silent: boolean;
  /** Which path is silent. */
  reasons: ("immediate" | "digest")[];
  /** The silence alert's delivery outcome, when one was raised this run. */
  alert: DeliveryOutcome | null;
}

/**
 * The silence check. Two ways alerting can go quiet without anyone noticing:
 *   - immediate: incidents needing attention arrived in the last 24h, but no
 *     immediate alert reached a person;
 *   - digest: hostile traffic fell in today's digest period, but today's
 *     digest was neither delivered nor found empty.
 * Raises its own alert, deduped once per UTC day. Runs after the digest hour.
 */
export async function runAlertSilenceCheck(deps: ForcefieldAlertDeps, now = new Date()): Promise<SilenceReport> {
  const hostileEvents = await deps.countAttentionEvents(SILENCE_LOOKBACK_HOURS).catch(() => 0);
  const deliveredAlerts = await deps.countDeliveredAlerts(SILENCE_LOOKBACK_HOURS).catch(() => 0);
  const reasons: SilenceReport["reasons"] = [];
  if (hostileEvents > 0 && deliveredAlerts === 0) reasons.push("immediate");
  let digestEvents = 0;
  let digestStatus: DigestRowStatus = null;
  const period = digestPeriod(now, null);
  if (period) {
    digestEvents = await deps.countHostileEventsBetween(period.start.toISOString(), period.end.toISOString()).catch(() => 0);
    digestStatus = await deps.digestStatus(digestKey(period.etDate)).catch(() => null);
    if (digestEvents > 0 && digestStatus !== "delivered" && digestStatus !== "empty") reasons.push("digest");
  }
  const silent = reasons.length > 0;
  if (!silent) return { hostileEvents, deliveredAlerts, digestEvents, digestStatus, silent, reasons, alert: null };

  await deps.track("forcefield.alert_silence_detected", {
    hostile_events: hostileEvents,
    delivered_alerts: deliveredAlerts,
    digest_events: digestEvents,
    digest_status: digestStatus ?? "missing",
    reasons: reasons.join(","),
    hours: SILENCE_LOOKBACK_HOURS,
  }).catch(() => {});
  const day = now.toISOString().slice(0, 10);
  const parts: string[] = [];
  if (reasons.includes("immediate")) {
    parts.push(`${hostileEvents} event(s) needing attention in the last ${SILENCE_LOOKBACK_HOURS}h, but no immediate Forcefield alert reached anyone.`);
  }
  if (reasons.includes("digest")) {
    parts.push(`${digestEvents} hostile event(s) in today's digest period, but today's daily digest was ${digestStatus === "failed" ? "not delivered" : "never sent"}.`);
  }
  const alert = await dispatchForcefieldAlert({
    kind: "alert_silence",
    dedupeKey: hashKey(["alert_silence", day]),
    title: "Forcefield: hostile traffic with no alert delivered",
    body: `${parts.join(" ")} The alert scan or its delivery is failing; check the forcefield-alerts cron and the Graph mail settings.`,
    windowStart: `${day}T00:00:00.000Z`,
    metadata: { hostile_events: hostileEvents, digest_events: digestEvents, reasons: reasons.join(",") },
  }, deps);
  return { hostileEvents, deliveredAlerts, digestEvents, digestStatus, silent, reasons, alert };
}

/** True when the cron invocation at `now` should run the daily silence check:
 *  the 15:00 UTC hour (11 AM EDT, 10 AM EST), after the 8 AM ET digest. The
 *  per-day dedupe makes repeats inside the hour no-ops. */
export function isSilenceCheckHour(now: Date): boolean {
  return now.getUTCHours() === 15;
}

/* ------------------------------ live adapters ----------------------------- */

const HOSTILE_EVENT_TYPES = ["site.agent_trap_tripped", "site.agent_payload_attack"];

/**
 * Our own verification traffic never pages anyone and is never counted in a
 * digest. An event is excluded ONLY when the engine stamped props.synthetic =
 * true, which observe.ts does only when the request presented the
 * x-forcefield-synthetic header matching FORCEFIELD_SYNTHETIC_TOKEN
 * (isSyntheticMonitor, constant-time). A user agent string never exempts
 * anything: it is spoofable, so a probe that only CLAIMS to be ours (e.g. UA
 * wolfpack-verify/1.0) still alerts. The events stay on the board; only the
 * page is suppressed. Applied to the scan, the digest AND the silence check,
 * so synthetic-only traffic cannot raise a false "no alert delivered" either.
 */
export const EXCLUDE_SYNTHETIC_SQL = `COALESCE(props->>'synthetic', '') <> 'true'`;

/** A request that was neither blocked nor sent into the decoy maze. */
const NOT_STOPPED_SQL = `COALESCE(props->>'blocked', '') <> 'true' AND COALESCE(props->>'tarpit', '') <> 'true' AND COALESCE(props->>'action', '') <> 'tarpit'`;

/** Needs attention: a trap trip, or any request not stopped. */
export const ATTENTION_SQL = `(event_type = 'site.agent_trap_tripped' OR (${NOT_STOPPED_SQL}))`;

/** The alert row id (same derivation as the dedupe store), shown in the email
 *  footer so a reader can find the row. */
export function alertRowId(alert: Pick<ForcefieldAlert, "kind" | "dedupeKey">): string {
  return hashKey([alert.kind, alert.dedupeKey]);
}

/**
 * In-app (fanoutToTeam) + email (Graph) to the Wolfpack security owner list
 * (alertRecipientEmails) ONLY. Build phase: no client or tenant ever receives a
 * Forcefield alert, and this is the only delivery path (guarded by
 * alert-delivery-guardrail.test.ts). Immediate incidents and the daily digest
 * both go through here, rendered by the shared operator template. Never throws.
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
export function liveAlertStore(): Pick<ForcefieldAlertDeps, "claimAlert" | "recordOutcome" | "recordDigestEmpty" | "digestResumeFrom" | "digestStatus" | "countDeliveredAlerts"> {
  return {
    claimAlert: async (alert) => {
      const id = hashKey([alert.kind, alert.dedupeKey]);
      // New incident -> inserted. Same incident already DELIVERED (or empty, or
      // out of attempts) -> the WHERE fails, 0 rows, no re-alert. A FAILED
      // attempt with attempts left -> re-claimed so the next scan retries it.
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
            SET delivery_status = $3, delivery_detail = $4, dispatched_at = now(), title = $5, body = $6
          WHERE alert_kind = $1 AND fingerprint = $2`,
        [alert.kind, alert.dedupeKey, outcome.status, outcome.detail || null, alert.title, alert.body],
      );
    },
    recordDigestEmpty: async (alert) => {
      await query(
        `UPDATE instinct_forcefield_web_alerts
            SET delivery_status = 'empty', delivery_detail = 'nothing_to_report', dispatched_at = now()
          WHERE alert_kind = 'alert_digest' AND fingerprint = $1`,
        [alert.dedupeKey],
      );
    },
    digestResumeFrom: async (beforeIso) => {
      // A digest row's window_start is its period END.
      const { rows } = await query<{ handled_end: string | null; first_unhandled_end: string | null }>(
        `WITH h AS (
           SELECT max(window_start) AS e FROM instinct_forcefield_web_alerts
            WHERE alert_kind = 'alert_digest'
              AND delivery_status IN ('delivered', 'empty')
              AND window_start < $1::timestamptz
         )
         SELECT (SELECT e FROM h) AS handled_end,
                (SELECT min(window_start) FROM instinct_forcefield_web_alerts
                  WHERE alert_kind = 'alert_digest'
                    AND COALESCE(delivery_status, 'failed') NOT IN ('delivered', 'empty')
                    AND window_start < $1::timestamptz
                    AND window_start > COALESCE((SELECT e FROM h), '-infinity'::timestamptz)) AS first_unhandled_end`,
        [beforeIso],
      );
      const r = rows[0];
      return digestResumeFrom(r?.handled_end ? new Date(r.handled_end) : null, r?.first_unhandled_end ? new Date(r.first_unhandled_end) : null);
    },
    digestStatus: async (dedupeKey) => {
      const { rows } = await query<{ s: string | null }>(
        `SELECT delivery_status AS s FROM instinct_forcefield_web_alerts WHERE alert_kind = 'alert_digest' AND fingerprint = $1`,
        [dedupeKey],
      );
      const s = rows[0]?.s ?? null;
      return s === "delivered" || s === "failed" || s === "empty" ? s : null;
    },
    countDeliveredAlerts: async (sinceHours) => {
      const { rows } = await safeQuery<{ n: string }>(
        `SELECT count(*) AS n FROM instinct_forcefield_web_alerts
          WHERE delivery_status = 'delivered'
            AND alert_kind NOT IN ('alert_silence', 'alert_digest')
            AND dispatched_at > now() - ($1 || ' hours')::interval`,
        [String(sinceHours)],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

/** Most distinct values of one attribute the alert carries (the rest are counted). */
export const DETAIL_LIST_CAP = LIST_CAP;

type EventGroupRow = {
  kind: string; site: string; attack: string; window_start: string | Date;
  fp: string; sig: string; path: string; country: string; hosting: string; client_type: string; agent: string; network: string;
  outcome: string; posture: string; reason_kind: string; n: string | number; first_at: string | Date; last_at: string | Date;
};

const iso = (v: string | Date) => new Date(v).toISOString();

/** Map one collapsed row to an event group. Exported for tests. */
export function eventGroupFromRow(r: EventGroupRow): HostileEventGroup {
  const kind = r.kind === "site.agent_trap_tripped" ? "honeytoken_trip" : "payload_attack";
  const outcome: EventOutcome = r.outcome === "blocked" || r.outcome === "contained" ? r.outcome : "recorded";
  return {
    kind,
    site: r.site ?? "",
    attackClass: r.attack === r.kind ? kind : r.attack,
    windowStart: iso(r.window_start),
    fp: r.fp ?? "",
    sig: r.sig ?? "",
    path: r.path ?? "",
    country: r.country ?? "",
    hosting: r.hosting ?? "",
    clientType: r.client_type ?? "",
    agent: r.agent ?? "",
    network: r.network ?? "",
    outcome,
    posture: r.posture ?? "",
    reasonKind: r.reason_kind ?? "",
    count: Number(r.n),
    firstAt: iso(r.first_at),
    lastAt: iso(r.last_at),
  };
}

/** The collapse query: identical facts become one row with an exact count. */
export const HOSTILE_EVENTS_SQL = `SELECT event_type AS kind,
        COALESCE(props->>'site', '') AS site,
        COALESCE(NULLIF(props->>'attack', ''), event_type) AS attack,
        to_timestamp(floor(extract(epoch FROM created_at) / ($3::int * 3600)) * ($3::int * 3600)) AS window_start,
        COALESCE(props->>'fp', '') AS fp,
        COALESCE(props->>'sig', '') AS sig,
        COALESCE(path, '') AS path,
        COALESCE(country, '') AS country,
        COALESCE(props->>'hosting', '') AS hosting,
        COALESCE(props->>'client_type', '') AS client_type,
        COALESCE(props->>'agent', '') AS agent,
        COALESCE(NULLIF(props->>'org', ''), NULLIF(props->>'asn', ''), '') AS network,
        CASE WHEN props->>'blocked' = 'true' THEN 'blocked'
             WHEN props->>'tarpit' = 'true' OR props->>'action' = 'tarpit' THEN 'contained'
             ELSE 'recorded' END AS outcome,
        COALESCE(props->>'posture', '') AS posture,
        COALESCE(props->>'reason_kind', '') AS reason_kind,
        count(*) AS n,
        min(created_at) AS first_at,
        max(created_at) AS last_at
   FROM site_analytics_events
  WHERE event_type = ANY($4::text[])
    AND created_at >= $1::timestamptz
    AND created_at < $2::timestamptz
    AND ${EXCLUDE_SYNTHETIC_SQL}
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15`;

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
    // query (not safeQuery): a read error must throw, so the scan reports it and
    // a digest is retried instead of being recorded as a quiet day.
    listHostileEvents: async (sinceIso, untilIso) => {
      const { rows } = await query<EventGroupRow>(HOSTILE_EVENTS_SQL, [sinceIso, untilIso, ALERT_WINDOW_HOURS, HOSTILE_EVENT_TYPES]);
      return rows.map(eventGroupFromRow);
    },
    // One email per incident: the automatic-block decision the ingest path
    // recorded for a trap trip is folded INTO the incident email (the ingest
    // path no longer sends its own notice for it).
    enrich: async (alert) => {
      const i = alert.incident;
      const hasTrap = alert.kind === "honeytoken_trip" || (alert.kind === "hostile_incident" && (alert.attention ?? []).includes("decoy"));
      if (!hasTrap || !i || i.fingerprints.length === 0) return alert;
      const decision = await lookupBlockDecision(i.fingerprints, i.windowStart);
      return decision ? { ...alert, incident: { ...i, blockDecision: decision } } : alert;
    },
    ...liveAlertStore(),
    deliver: deliverForcefieldAlert,
    track: (event, payload) => trackEventAwait(event, "system", "forcefield", payload),
    countAttentionEvents: async (sinceHours) => {
      const { rows } = await safeQuery<{ n: string }>(
        `SELECT count(*) AS n FROM site_analytics_events
          WHERE event_type = ANY($2::text[])
            AND created_at > now() - ($1 || ' hours')::interval
            AND ${EXCLUDE_SYNTHETIC_SQL}
            AND ${ATTENTION_SQL}`,
        [String(sinceHours), HOSTILE_EVENT_TYPES],
      );
      return Number(rows[0]?.n ?? 0);
    },
    countHostileEventsBetween: async (sinceIso, untilIso) => {
      const { rows } = await safeQuery<{ n: string }>(
        `SELECT count(*) AS n FROM site_analytics_events
          WHERE event_type = ANY($3::text[])
            AND created_at >= $1::timestamptz
            AND created_at < $2::timestamptz
            AND ${EXCLUDE_SYNTHETIC_SQL}`,
        [sinceIso, untilIso, HOSTILE_EVENT_TYPES],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}
