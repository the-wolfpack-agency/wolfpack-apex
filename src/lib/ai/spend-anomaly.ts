/**
 * Daily AI spend-spike detection.
 *
 * WHY A SPIKE ALERT AND NOT ONLY A CAP
 *
 * The budget governor (lib/ai/budget.ts) bounds a month. It cannot tell a
 * normal month from a month that went wrong on Tuesday: a workspace capped at
 * $1,000 that normally spends $0.30 a day can burn $24 a day for five weeks
 * before the governor even clamps. That is not hypothetical. Production ran at
 * about $24 a day from 2026-10-08 to 2026-10-18 (ai-code-ci-fix, our own
 * dogfooding), against about $0.30 a day either side of it, and nothing said
 * a word. Whether a run like that is dogfooding or somebody else's loop on a
 * stolen key is exactly the question a person should be asked the morning it
 * starts, not at the end of the month.
 *
 * THE RULE, DETERMINISTIC, NO MODEL ANYWHERE NEAR IT
 *
 * Per bucket (each workspace, plus __unattributed__ for calls with none):
 *
 *   last24h = spend in the 24 hours before the scan
 *   mean    = spend in the 7 days before that, divided by 7
 *
 *   spike       history exists, last24h > 3 x mean AND last24h > $5
 *   new_spend   no calls at all in the trailing 7 days AND last24h > $25
 *
 * The $5 floor keeps a bucket that went from $0.10 to $0.40 from paging
 * anybody. The mean divides by seven whatever the history length, so a bucket
 * a few days old reads as quieter than it is and alerts sooner, the safe side
 * to be wrong on.
 *
 * Backtested against the production series (see the fixture test): the rule
 * fires on 2026-10-08 ($13.89 against a $2.59 mean), 2026-10-09 and 2026-10-10,
 * then goes quiet on 2026-10-11 because $24 a day has become the mean. That is
 * the behavior wanted: told on day one, not every day for a fortnight.
 *
 * IDEMPOTENT PER DAY
 *
 * The ai.spend_anomaly_detected event is both the alert record and the ledger:
 * before alerting, the scan reads which buckets already have one for today's
 * UTC date and skips them. Recorded (awaited) BEFORE the fanout, so a fanout
 * that fails cannot cause a second alert on a re-run, only a missed bell,
 * which the event itself still shows.
 *
 * Alert channel: the existing team notification layer (fanoutToTeam -> notify),
 * the same path the Forcefield web alerts use. No new channel.
 */
import { query } from "@/lib/db";
import { trackEventAwait } from "@/lib/analytics";
import { fanoutToTeam, type TeamFanoutInput } from "@/lib/notifications/team-fanout";
import { UNATTRIBUTED_BUCKET } from "./spend-guard";

export const SPIKE_MULTIPLE = 3;
export const SPIKE_MIN_USD = 5;
export const NO_HISTORY_MIN_USD = 25;
export const TRAILING_DAYS = 7;

/**
 * Spend alerts go to the owner of AI spend ONLY, like the Forcefield alerts:
 * this is an operational and security signal, not team news. Comma-separated
 * list via AI_SPEND_ALERT_RECIPIENT_EMAIL; defaults to the CTO work account.
 */
function alertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AI_SPEND_ALERT_RECIPIENT_EMAIL || "homyk@thewolfpack.agency")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

export interface SpendWindow {
  /** A workspace id, or UNATTRIBUTED_BUCKET. */
  bucket: string;
  last24hUsd: number;
  last24hCalls: number;
  /** Spend in the TRAILING_DAYS before the last 24 hours. */
  trailingUsd: number;
  trailingCalls: number;
}

export type AnomalyReason = "spike" | "new_spend";

export interface SpendAnomaly {
  bucket: string;
  reason: AnomalyReason;
  last24hUsd: number;
  last24hCalls: number;
  trailingUsd: number;
  meanDailyUsd: number;
  /** last24h / mean. Null when there is no history to divide by. */
  multiple: number | null;
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** Decide one bucket. Pure. */
export function evaluateSpendWindow(w: SpendWindow): SpendAnomaly | null {
  const last = finite(w.last24hUsd);
  const trailing = finite(w.trailingUsd);
  const mean = trailing / TRAILING_DAYS;
  const hasHistory = w.trailingCalls > 0;

  if (!hasHistory) {
    if (last > NO_HISTORY_MIN_USD) {
      return {
        bucket: w.bucket,
        reason: "new_spend",
        last24hUsd: last,
        last24hCalls: w.last24hCalls,
        trailingUsd: trailing,
        meanDailyUsd: 0,
        multiple: null,
      };
    }
    return null;
  }

  if (last > SPIKE_MIN_USD && last > SPIKE_MULTIPLE * mean) {
    return {
      bucket: w.bucket,
      reason: "spike",
      last24hUsd: last,
      last24hCalls: w.last24hCalls,
      trailingUsd: trailing,
      meanDailyUsd: mean,
      multiple: mean > 0 ? last / mean : null,
    };
  }
  return null;
}

export function detectSpendAnomalies(windows: SpendWindow[]): SpendAnomaly[] {
  return windows.map(evaluateSpendWindow).filter((a): a is SpendAnomaly => a !== null);
}

/** The dedupe key: the UTC calendar date the scan ran on. */
export function anomalyDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

export function describeAnomaly(a: SpendAnomaly): { title: string; body: string } {
  const who = a.bucket === UNATTRIBUTED_BUCKET ? "calls with no workspace" : `workspace ${a.bucket}`;
  const title = `AI spend spike: ${usd(a.last24hUsd)} in 24h (${who})`;
  const body =
    a.reason === "spike"
      ? `AI spend for ${who} was ${usd(a.last24hUsd)} over the last 24 hours across ${a.last24hCalls} calls, ` +
        `${(a.multiple ?? 0).toFixed(1)} times its trailing ${TRAILING_DAYS}-day daily mean of ${usd(a.meanDailyUsd)}. ` +
        `If this is not expected use, treat it as a possible leaked key or runaway loop: check ai.completion by feature for this bucket.`
      : `AI spend for ${who} was ${usd(a.last24hUsd)} over the last 24 hours across ${a.last24hCalls} calls, ` +
        `with no AI calls at all in the ${TRAILING_DAYS} days before. ` +
        `If this is not expected use, treat it as a possible leaked key or runaway loop: check ai.completion by feature for this bucket.`;
  return { title, body };
}

export interface SpendAnomalyDeps {
  listWindows: () => Promise<SpendWindow[]>;
  /** Buckets already alerted for this day key. */
  listAlerted: (dayKey: string) => Promise<Set<string>>;
  /** Write the alert record (and the dedupe ledger row). Must be awaited. */
  record: (a: SpendAnomaly, dayKey: string) => Promise<void>;
  fanout: (input: TeamFanoutInput) => Promise<void>;
}

export interface SpendAnomalyScanResult {
  day: string;
  scanned: number;
  detected: number;
  dispatched: number;
  alreadyAlerted: number;
}

/**
 * Scan, decide, alert. A read failure throws to the caller (the cron route),
 * which reports it rather than pretending the scan was clean. A failed fanout
 * does not throw: the record is already written.
 */
export async function runSpendAnomalyScan(deps: SpendAnomalyDeps, now: Date = new Date()): Promise<SpendAnomalyScanResult> {
  const day = anomalyDayKey(now);
  const windows = await deps.listWindows();
  const anomalies = detectSpendAnomalies(windows);
  const alerted = anomalies.length ? await deps.listAlerted(day) : new Set<string>();

  let dispatched = 0;
  let alreadyAlerted = 0;
  for (const a of anomalies) {
    if (alerted.has(a.bucket)) {
      alreadyAlerted++;
      continue;
    }
    await deps.record(a, day);
    const { title, body } = describeAnomaly(a);
    await deps
      .fanout({
        actor: { id: "system", role: "system", name: "AI spend guard" },
        title,
        body,
        actionUrl: "/admin/ai-router",
        actionLabel: "Open AI router",
        category: "security",
        recipientEmails: alertRecipients(),
        source: "ai-spend-anomaly",
        sourceId: `${a.bucket}:${day}`,
        metadata: { bucket: a.bucket, day, reason: a.reason, last_24h_usd: a.last24hUsd },
        analyticsEvent: "ai.spend_anomaly_alert_dispatched",
        analyticsPayload: { bucket: a.bucket, day, reason: a.reason },
      })
      .catch(() => undefined);
    dispatched++;
  }
  return { day, scanned: windows.length, detected: anomalies.length, dispatched, alreadyAlerted };
}

const COST = `NULLIF(metadata->>'cost_usd', '')::numeric`;

export function liveSpendAnomalyDeps(): SpendAnomalyDeps {
  return {
    listWindows: async () => {
      /* One pass over eight days of ai.completion, on the (event_type,
         timestamp) index. The bucket expression matches spend-guard's: an
         absent or blank workspace_id is __unattributed__, and 'default' is a
         real workspace. */
      const { rows } = await query<{
        bucket: string;
        last24h_usd: string | number;
        last24h_calls: string | number;
        trailing_usd: string | number;
        trailing_calls: string | number;
      }>(
        `SELECT COALESCE(NULLIF(btrim(metadata->>'workspace_id'), ''), $1) AS bucket,
                COALESCE(SUM(${COST}) FILTER (WHERE timestamp > now() - interval '24 hours'), 0) AS last24h_usd,
                COUNT(*) FILTER (WHERE timestamp > now() - interval '24 hours') AS last24h_calls,
                COALESCE(SUM(${COST}) FILTER (WHERE timestamp <= now() - interval '24 hours'), 0) AS trailing_usd,
                COUNT(*) FILTER (WHERE timestamp <= now() - interval '24 hours') AS trailing_calls
           FROM instinct_events
          WHERE event_type = 'ai.completion'
            AND timestamp > now() - interval '8 days'
          GROUP BY 1`,
        [UNATTRIBUTED_BUCKET],
      );
      return rows.map((r) => ({
        bucket: r.bucket,
        last24hUsd: Number(r.last24h_usd),
        last24hCalls: Number(r.last24h_calls),
        trailingUsd: Number(r.trailing_usd),
        trailingCalls: Number(r.trailing_calls),
      }));
    },
    listAlerted: async (dayKey) => {
      const { rows } = await query<{ bucket: string }>(
        `SELECT DISTINCT metadata->>'bucket' AS bucket
           FROM instinct_events
          WHERE event_type = 'ai.spend_anomaly_detected'
            AND timestamp > now() - interval '2 days'
            AND metadata->>'day' = $1`,
        [dayKey],
      );
      return new Set(rows.map((r) => r.bucket));
    },
    record: async (a, dayKey) => {
      await trackEventAwait("ai.spend_anomaly_detected", "system", "system", {
        bucket: a.bucket,
        day: dayKey,
        reason: a.reason,
        last_24h_usd: Number(a.last24hUsd.toFixed(4)),
        last_24h_calls: a.last24hCalls,
        trailing_7d_usd: Number(a.trailingUsd.toFixed(4)),
        trailing_mean_daily_usd: Number(a.meanDailyUsd.toFixed(4)),
        multiple: a.multiple === null ? -1 : Number(a.multiple.toFixed(2)),
      });
    },
    fanout: async (input) => {
      await fanoutToTeam(input);
    },
  };
}
