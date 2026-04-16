/**
 * Mail signals — read helpers over instinct_sent_mail that feed
 * the Wolfpack Assistant and behavioral analytics brain.
 *
 * Pure reads (no mutations, no analytics). Consumers:
 *   - Assistant briefings: "You haven't replied to X in 2 weeks"
 *   - Optimal send-time suggestion for the composer
 *   - Per-recipient responsiveness learning loop
 *
 * These functions are **exported but not yet wired to a UI surface** —
 * Tier 1 is about getting the data flowing. TODO: consumer integrations.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipientReplyStats {
  recipient: string;
  sent_count: number;
  reply_count: number;
  reply_rate: number; // 0..1
}

export interface OptimalSendHourBucket {
  hour: number; // 0..23 local
  sent_count: number;
  fast_reply_count: number; // reply arrived < 4h
  fast_reply_rate: number;
}

// ---------------------------------------------------------------------------
// Reply rate per recipient
// ---------------------------------------------------------------------------

/**
 * For each recipient the user emailed in the last `windowDays`, compute
 * the proportion of those threads where a reply from that recipient
 * landed within the window.
 *
 * The "reply came back" heuristic joins instinct_sent_mail.ms_message_id
 * back to instinct_sent_mail.in_reply_to (when the user replied back to
 * a thread that was initiated by the recipient). This is a minimal
 * signal; a richer version would join against received-mail tables
 * (Tier 2 — Mail.Read cache).
 *
 * Returns rows sorted by sent_count DESC, capped at 100.
 */
export async function getReplyRatePerRecipient(
  userId: string,
  windowDays: number = 30,
): Promise<RecipientReplyStats[]> {
  const result = await safeQuery<{
    recipient: string;
    sent_count: string;
    reply_count: string;
  }>(
    `WITH recent_sends AS (
       SELECT id, ms_message_id,
              jsonb_array_elements_text(to_recipients) AS recipient,
              sent_at
         FROM instinct_sent_mail
        WHERE user_id = $1
          AND sent_at > NOW() - INTERVAL '1 day' * $2
     ),
     replies AS (
       SELECT DISTINCT in_reply_to
         FROM instinct_sent_mail
        WHERE user_id = $1
          AND in_reply_to IS NOT NULL
          AND sent_at > NOW() - INTERVAL '1 day' * $2
     )
     SELECT rs.recipient,
            COUNT(*)::text AS sent_count,
            COUNT(DISTINCT r.in_reply_to)::text AS reply_count
       FROM recent_sends rs
  LEFT JOIN replies r ON r.in_reply_to = rs.ms_message_id
      GROUP BY rs.recipient
      ORDER BY sent_count DESC
      LIMIT 100`,
    [userId, windowDays],
  );

  return result.rows.map((row) => {
    const sent = parseInt(row.sent_count, 10) || 0;
    const replied = parseInt(row.reply_count, 10) || 0;
    return {
      recipient: row.recipient,
      sent_count: sent,
      reply_count: replied,
      reply_rate: sent > 0 ? Math.min(1, replied / sent) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Optimal send hour
// ---------------------------------------------------------------------------

/**
 * Build a 24-bucket histogram of send hour (user-local, approximated
 * via AT TIME ZONE 'UTC') tagged with "fast reply" count — where a reply
 * to that send (same in_reply_to chain) arrived within 4 hours.
 *
 * The caller picks the bucket with the highest fast_reply_rate as the
 * suggested best send-hour for the composer.
 */
export async function getOptimalSendHour(
  userId: string,
  windowDays: number = 60,
): Promise<OptimalSendHourBucket[]> {
  const result = await safeQuery<{
    hour: string;
    sent_count: string;
    fast_reply_count: string;
  }>(
    `WITH sent AS (
       SELECT ms_message_id,
              EXTRACT(HOUR FROM sent_at AT TIME ZONE 'UTC')::int AS hour,
              sent_at
         FROM instinct_sent_mail
        WHERE user_id = $1
          AND sent_at > NOW() - INTERVAL '1 day' * $2
     ),
     replies AS (
       SELECT in_reply_to, MIN(sent_at) AS first_reply_at
         FROM instinct_sent_mail
        WHERE user_id = $1
          AND in_reply_to IS NOT NULL
        GROUP BY in_reply_to
     )
     SELECT s.hour::text,
            COUNT(*)::text AS sent_count,
            SUM(CASE WHEN r.first_reply_at IS NOT NULL
                      AND r.first_reply_at - s.sent_at < INTERVAL '4 hours'
                     THEN 1 ELSE 0 END)::text AS fast_reply_count
       FROM sent s
  LEFT JOIN replies r ON r.in_reply_to = s.ms_message_id
      GROUP BY s.hour
      ORDER BY s.hour ASC`,
    [userId, windowDays],
  );

  const buckets: OptimalSendHourBucket[] = [];
  const byHour = new Map<number, OptimalSendHourBucket>();
  for (const row of result.rows) {
    const hour = parseInt(row.hour, 10);
    const sent = parseInt(row.sent_count, 10) || 0;
    const fast = parseInt(row.fast_reply_count, 10) || 0;
    byHour.set(hour, {
      hour,
      sent_count: sent,
      fast_reply_count: fast,
      fast_reply_rate: sent > 0 ? fast / sent : 0,
    });
  }
  // Return all 24 hours so callers can compare gaps without null checks.
  for (let h = 0; h < 24; h++) {
    buckets.push(
      byHour.get(h) ?? {
        hour: h,
        sent_count: 0,
        fast_reply_count: 0,
        fast_reply_rate: 0,
      },
    );
  }
  return buckets;
}
