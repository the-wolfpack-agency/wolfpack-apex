/**
 * Notification learning signals — raw rate extractors that feed a
 * future ranker / auto-downgrade engine.
 *
 * We do NOT build the ranker here. These functions just surface rates
 * so the downstream learning loop can decide whether to auto-downgrade
 * noisy categories or promote categories a user actually acts on.
 *
 * All data is pulled from apex_events (analytics) so per-user category
 * engagement is measured from real behavior, not from notification
 * metadata that could drift.
 */

import { safeQuery } from "@/lib/db";

export interface EngagementRate {
  user_id: string;
  window_days: number;
  total: number;
  read: number;
  clicked: number;
  dismissed: number;
  engagement_rate: number; // (read + clicked) / total; 0 when total = 0
}

export interface CategoryPriorityScore {
  user_id: string;
  category: string;
  seen: number;
  read_or_clicked: number;
  dismissed: number;
  /** 1.0 = always engages; 0.0 = never engages. null when seen = 0. */
  score: number | null;
}

/**
 * Engagement across all notifications created for this user in a time
 * window. Joins on notification_id in event metadata.
 *
 * Because apex_events metadata is JSONB and notification_id is stored as
 * metadata.notification_id, we count unique notification_ids per event
 * type.
 */
export async function getEngagementRate(
  userId: string,
  windowDays = 30,
): Promise<EngagementRate> {
  const result = await safeQuery<{
    event_type: string;
    count: string;
  }>(
    `SELECT event_type, COUNT(DISTINCT metadata->>'notification_id')::text AS count
       FROM apex_events
       WHERE user_id = $1
         AND event_type IN (
           'system.notification_created',
           'system.notification_read',
           'system.notification_clicked',
           'system.notification_dismissed'
         )
         AND timestamp > NOW() - INTERVAL '1 day' * $2
       GROUP BY event_type`,
    [userId, windowDays],
  );

  const counts: Record<string, number> = {};
  for (const r of result.rows) counts[r.event_type] = Number(r.count);

  const total = counts["system.notification_created"] ?? 0;
  const read = counts["system.notification_read"] ?? 0;
  const clicked = counts["system.notification_clicked"] ?? 0;
  const dismissed = counts["system.notification_dismissed"] ?? 0;
  const engagement_rate = total > 0 ? (read + clicked) / total : 0;

  return {
    user_id: userId,
    window_days: windowDays,
    total,
    read,
    clicked,
    dismissed,
    engagement_rate,
  };
}

/**
 * How often a user engages with a given category. Used by the (future)
 * ranker to auto-downgrade noisy categories per user.
 *
 * score = (read + clicked) / seen   when seen > 0
 * score = null                      when seen = 0 (no opinion yet)
 */
export async function getCategoryPriorityScore(
  userId: string,
  category: string,
  windowDays = 60,
): Promise<CategoryPriorityScore> {
  // First, pull the set of notification ids in this category for the user.
  const idsResult = await safeQuery<{ id: string }>(
    `SELECT id::text FROM instinct_notifications
       WHERE user_id = $1 AND category = $2
         AND created_at > NOW() - INTERVAL '1 day' * $3`,
    [userId, category, windowDays],
  );
  const ids = idsResult.rows.map((r) => r.id);
  if (ids.length === 0) {
    return {
      user_id: userId,
      category,
      seen: 0,
      read_or_clicked: 0,
      dismissed: 0,
      score: null,
    };
  }

  // Then count read/clicked/dismissed events whose metadata.notification_id
  // is in that set.
  const counts = await safeQuery<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(DISTINCT metadata->>'notification_id')::text AS count
       FROM apex_events
       WHERE user_id = $1
         AND event_type IN (
           'system.notification_read',
           'system.notification_clicked',
           'system.notification_dismissed'
         )
         AND metadata->>'notification_id' = ANY($2::text[])
       GROUP BY event_type`,
    [userId, ids],
  );

  const map: Record<string, number> = {};
  for (const r of counts.rows) map[r.event_type] = Number(r.count);

  const read = map["system.notification_read"] ?? 0;
  const clicked = map["system.notification_clicked"] ?? 0;
  const dismissed = map["system.notification_dismissed"] ?? 0;
  const readOrClicked = Math.min(read + clicked, ids.length);

  return {
    user_id: userId,
    category,
    seen: ids.length,
    read_or_clicked: readOrClicked,
    dismissed,
    score: readOrClicked / ids.length,
  };
}

// TODO (ranker): combine per-category scores with recency + volume to
// auto-downgrade categories below a threshold. Not wired yet — these
// extractors exist so the ranker can be added without event back-fill.
