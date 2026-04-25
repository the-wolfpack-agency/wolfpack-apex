/**
 * porsche-classes / notify-summary-ready —
 *
 * When a class transitions from <4 sources to =4 sources for the first
 * time (porsche_xlsx + cognito_coordinator + cognito_instructor + survey
 * all present), email the operator(s) configured in the porsche-classes
 * config under the `notify_recipients` key. Single-fire per class —
 * tracked in `instinct_automation_porsche_notifications` so re-ingests
 * do not spam recipients.
 *
 * Design:
 *   - notifySummaryReady(...)              → send the email NOW (no
 *                                             transition / idempotency
 *                                             guard) — used when the
 *                                             caller has already decided
 *                                             a fire is warranted.
 *   - notifySummaryReadyIfTransition(...)  → orchestrator: counts
 *                                             distinct sources,
 *                                             short-circuits if !=4 or
 *                                             already-notified, then
 *                                             calls notifySummaryReady.
 *                                             This is what ingest.ts
 *                                             calls.
 *
 * Email provider: Resend (existing; same util pattern as
 * src/lib/goals-digest.ts). No new providers added — per the user's
 * permanent engineering directive ("No new runtime dependencies without
 * justification").
 *
 * Body shape: plain text, one paragraph + a single deep link, NO HTML
 * chrome. Operators are non-technical and shouldn't be drowned in
 * branding for a "ready" notification.
 *
 * NEVER throws. Every failure path returns an `ok` discriminator so the
 * ingest orchestrator can fire-and-forget without try/catch.
 */

import { query, writeQuery } from "@/lib/db";
import { getConfig } from "./config-repo";
import type { AutomationId } from "@/lib/automations/types";

// ---------------------------------------------------------------------------
// Constants — required-source set is the contract from types.ts
// ---------------------------------------------------------------------------

/**
 * The four source_types whose presence drives a class to "summary ready".
 * Order is irrelevant for the count; we care about the SET cardinality.
 *
 * Kept in lockstep with `AutomationSourceType` in types.ts. If a future
 * automation adds a fifth source we widen this and the README; the DB
 * notifications table stores a single timestamp so it doesn't need a
 * schema change.
 */
export const REQUIRED_SOURCES_FOR_READY: ReadonlyArray<string> = [
  "porsche_xlsx",
  "cognito_coordinator",
  "cognito_instructor",
  "survey",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NotifySummaryReadyResult =
  | { ok: true; channel: "resend" | "queue"; recipient_count: number }
  | { ok: false; skipped: NotifySkippedReason };

export type NotifySkippedReason =
  | "already_notified"
  | "not_yet_ready"
  | "no_recipients"
  | "no_provider"
  | "summary_unavailable"
  | "send_failed";

export interface NotifySummaryReadyArgs {
  class_key: string;
  recipients: string[];
  /** Deep link to the class-summary page. */
  summary_url: string;
  /** Optional injection point so tests can replace fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Send the email NOW. Pre-flight checks (recipients > 0, provider
 * available) are still applied so the caller never has to gate them.
 *
 * Returns a structured result — NEVER throws. The ingest path treats
 * `{ ok: false }` as "log + move on", since the underlying class data
 * is already persisted.
 */
export async function notifySummaryReady(
  args: NotifySummaryReadyArgs,
): Promise<NotifySummaryReadyResult> {
  // Empty recipients = configured-but-empty wizard step; treat as
  // "explicitly opted out" rather than misconfiguration.
  if (!Array.isArray(args.recipients) || args.recipients.length === 0) {
    return { ok: false, skipped: "no_recipients" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // No provider — caller MAY still want to record the attempt to a
    // queue table for delivery later. We don't do that here (ingest
    // doesn't need it; goals-digest does its own queue), so just skip.
    return { ok: false, skipped: "no_provider" };
  }

  // Look up the assembled summary so the subject can carry course /
  // location / date — operators triage on-glance from the subject line.
  // Cheap one-row read; we already paid for the writes that drove this
  // call, the read is incidental.
  const subjectParts = await loadSubjectParts(args.class_key);
  if (!subjectParts) {
    return { ok: false, skipped: "summary_unavailable" };
  }

  const from =
    process.env.INSTINCT_NOTIFY_FROM ??
    process.env.INSTINCT_DIGEST_FROM ??
    "automations@wolfpack.agency";
  const subject = `Class summary ready: ${subjectParts.course} ${subjectParts.location} ${subjectParts.class_date}`;
  const body = buildBody({
    course: subjectParts.course,
    location: subjectParts.location,
    class_date: subjectParts.class_date,
    summary_url: args.summary_url,
  });

  const fetchImpl = args.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: args.recipients,
        subject,
        text: body,
      }),
    });
  } catch {
    return { ok: false, skipped: "send_failed" };
  }
  if (!res.ok) {
    return { ok: false, skipped: "send_failed" };
  }
  return {
    ok: true,
    channel: "resend",
    recipient_count: args.recipients.length,
  };
}

/* ------------------------------------------------------------------ */
/* Transition detector — what the ingest path calls                   */
/* ------------------------------------------------------------------ */

export interface NotifyIfTransitionArgs {
  automation_id: AutomationId | string;
  class_key: string;
  /** Inject for tests; production uses live DB + fetch. */
  loadDistinctSourceCount?: typeof defaultLoadDistinctSourceCount;
  loadSubjectParts?: typeof loadSubjectParts;
  loadRecipients?: typeof loadRecipients;
  fetchImpl?: typeof fetch;
  /** Deep link base — production override comes from env. */
  summaryUrlBuilder?: (class_key: string) => string;
}

/**
 * Orchestrator: only sends when ALL of the following hold:
 *   1. The class now has all four required source_types ingested.
 *   2. We have NOT already sent a "ready" notification for this class.
 *   3. The config has at least one notify_recipients email.
 *   4. RESEND_API_KEY is set.
 *
 * On a successful send, INSERTs a row into
 * instinct_automation_porsche_notifications keyed by (automation_id,
 * class_key) so subsequent re-ingests (idempotent path in ingest.ts)
 * never re-trigger.
 *
 * The idempotency row is also written when we skip for a benign reason
 * (no recipients, no provider) so we don't revisit the check on every
 * artifact — the operator must explicitly clear the row to retry. That
 * matches the "ready is a once-per-class lifecycle event" mental model.
 */
export async function notifySummaryReadyIfTransition(
  args: NotifyIfTransitionArgs,
): Promise<NotifySummaryReadyResult> {
  // Already-sent guard FIRST — cheapest read, short-circuits early.
  const already = await hasAlreadyNotified({
    automation_id: args.automation_id,
    class_key: args.class_key,
  });
  if (already) {
    return { ok: false, skipped: "already_notified" };
  }

  // Are all four sources present?
  const countLoader =
    args.loadDistinctSourceCount ?? defaultLoadDistinctSourceCount;
  const distinctSources = await countLoader(args.class_key);
  if (distinctSources < REQUIRED_SOURCES_FOR_READY.length) {
    return { ok: false, skipped: "not_yet_ready" };
  }

  // Recipients from config — string[] under key 'notify_recipients'. Per
  // the spec, the key may not yet exist (the onboarding wizard owns the
  // setter); when it's missing we record a "skipped_no_recipients"
  // notification row so we don't re-check on every artifact. The
  // operator clears the row by setting recipients in config and the
  // wizard posting a follow-up.
  const recipientsLoader = args.loadRecipients ?? loadRecipients;
  const recipients = await recipientsLoader();

  if (recipients.length === 0) {
    await markNotified({
      automation_id: args.automation_id,
      class_key: args.class_key,
      channel: "skipped_no_recipients",
      recipient_count: 0,
    });
    return { ok: false, skipped: "no_recipients" };
  }

  if (!process.env.RESEND_API_KEY) {
    await markNotified({
      automation_id: args.automation_id,
      class_key: args.class_key,
      channel: "skipped_no_provider",
      recipient_count: recipients.length,
    });
    return { ok: false, skipped: "no_provider" };
  }

  const summaryUrl = (args.summaryUrlBuilder ?? defaultSummaryUrl)(
    args.class_key,
  );

  // Send.
  const result = await notifySummaryReady({
    class_key: args.class_key,
    recipients,
    summary_url: summaryUrl,
    fetchImpl: args.fetchImpl,
  });

  if (result.ok) {
    await markNotified({
      automation_id: args.automation_id,
      class_key: args.class_key,
      channel: result.channel,
      recipient_count: result.recipient_count,
    });
  }
  // We INTENTIONALLY do NOT mark-notified on send_failed — a transient
  // Resend outage should NOT permanently consume the once-per-class slot.
  return result;
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

interface SubjectParts {
  course: string;
  location: string;
  class_date: string;
}

/**
 * Pull course / location / class_date from any snapshot for this
 * class_key. Returns null when no snapshot exists (the orchestrator
 * already filtered by source-count, so this is a defensive guard).
 */
export async function loadSubjectParts(
  class_key: string,
): Promise<SubjectParts | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await query<{
      course_type: string;
      location: string;
      class_date: string;
    }>(
      `SELECT course_type, location, class_date::text AS class_date
         FROM instinct_automation_porsche_snapshots
        WHERE class_key = $1
        ORDER BY captured_at DESC
        LIMIT 1`,
      [class_key],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      course: row.course_type,
      location: row.location,
      class_date: row.class_date,
    };
  } catch {
    return null;
  }
}

/**
 * Default distinct-source counter — counts unique source_type values
 * for this class_key. Injectable for tests so we don't need to seed
 * snapshots to assert the orchestrator wiring.
 */
async function defaultLoadDistinctSourceCount(
  class_key: string,
): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  try {
    const r = await query<{ n: number }>(
      `SELECT COUNT(DISTINCT source_type)::int AS n
         FROM instinct_automation_porsche_snapshots
        WHERE class_key = $1
          AND source_type = ANY($2::text[])`,
      [class_key, REQUIRED_SOURCES_FOR_READY as string[]],
    );
    return r.rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function hasAlreadyNotified(args: {
  automation_id: string | AutomationId;
  class_key: string;
}): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const r = await query<{ class_key: string }>(
      `SELECT class_key
         FROM instinct_automation_porsche_notifications
        WHERE automation_id = $1
          AND class_key     = $2
        LIMIT 1`,
      [args.automation_id, args.class_key],
    );
    return r.rows.length > 0;
  } catch {
    // Default to "not yet" so a transient pg blip doesn't suppress the
    // notification permanently; the unique PK on the table prevents
    // duplicates if the second attempt actually inserts.
    return false;
  }
}

async function markNotified(args: {
  automation_id: string | AutomationId;
  class_key: string;
  channel: "resend" | "queue" | "skipped_no_recipients" | "skipped_no_provider";
  recipient_count: number;
}): Promise<void> {
  try {
    await writeQuery(
      `INSERT INTO instinct_automation_porsche_notifications
         (automation_id, class_key, channel, recipient_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (automation_id, class_key) DO NOTHING
       RETURNING class_key`,
      [args.automation_id, args.class_key, args.channel, args.recipient_count],
    );
  } catch (err) {
    // Best-effort. Don't poison the caller — the email was already sent
    // (or skipped); a missing audit row is preferable to a thrown error
    // that bubbles out into the ingest write path.
    console.warn(
      `[notify-summary-ready] markNotified failed: ${(err as Error).message}`,
    );
  }
}

/** Read recipients from config-repo. Returns [] when the key is missing. */
export async function loadRecipients(): Promise<string[]> {
  // The wizard's writer owns the schema; we read defensively here so a
  // legacy / stringy value doesn't crash the ingest path.
  const stored = (await getConfig("notify_recipients")) as unknown | null;
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.includes("@") && s.length <= 320);
}

/**
 * Build the deep-link URL the email points to. Reuses
 * NEXT_PUBLIC_APP_URL when set (already the convention for outbound
 * emails in this repo) so the link works in dev, preview, and prod.
 *
 * URL-encodes the class_key so the `|` separator in
 * `course|YYYY-MM-DD|location` survives in the path.
 */
export function defaultSummaryUrl(class_key: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.PROD_DOMAIN ??
    "https://app.wolfpack.agency";
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/automations/porsche-classes/summaries/${encodeURIComponent(class_key)}`;
}

/**
 * Compose the email body — one paragraph + a single link. Plain text
 * only, NO HTML, no chrome.
 */
function buildBody(args: {
  course: string;
  location: string;
  class_date: string;
  summary_url: string;
}): string {
  return (
    `The class summary for ${args.course} on ${args.class_date} ` +
    `at ${args.location} is now ready — all four data sources have ` +
    `been ingested (registration roster, coordinator notes, instructor ` +
    `notes, and survey responses). You can review or share it here:\n\n` +
    `${args.summary_url}\n`
  );
}
