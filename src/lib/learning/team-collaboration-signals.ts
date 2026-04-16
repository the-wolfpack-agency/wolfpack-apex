/**
 * Team collaboration signals (Tier 2 · Stream E).
 *
 * Pure read helpers over instinct_teams_teams / channels / channel_messages.
 * The Assistant composes these with other signals to answer questions like
 * "which channels am I being @-mentioned in the most?" and to rank a user's
 * active channels when delivering briefings.
 *
 * No mutations, no analytics — ranker hookup is TODO for a future PR.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelActivityDay {
  day: string; // YYYY-MM-DD
  message_count: number;
}

export interface ChannelActivity {
  channel_id: string;
  window_days: number;
  total_messages: number;
  active_participants: number;
  messages_per_day: ChannelActivityDay[];
}

export interface ChannelMention {
  message_id: string;
  ms_message_id: string;
  channel_id: string;
  channel_name: string;
  team_name: string;
  sender: string;
  body_preview: string;
  subject: string | null;
  importance: "low" | "normal" | "high";
  urgency_score: number; // 0..1
  created_at: string;
}

export interface MentionAggregation {
  user_id: string;
  window_days: number;
  total_mentions: number;
  high_importance_count: number;
  avg_urgency: number;
  top_channels: {
    channel_id: string;
    channel_name: string;
    team_name: string;
    mention_count: number;
  }[];
  recent: ChannelMention[];
}

export interface TopActiveChannel {
  channel_id: string;
  channel_name: string;
  team_name: string;
  team_id: string;
  message_count: number;
  participant_count: number;
  last_message_at: string | null;
}

// ---------------------------------------------------------------------------
// Channel activity
// ---------------------------------------------------------------------------

/**
 * Messages per day + active participants for a channel over the last
 * `windowDays`. Returns zeros on empty channels, not null, so dashboard
 * tiles always render.
 */
export async function getChannelActivity(
  channelId: string,
  windowDays: number = 14,
): Promise<ChannelActivity> {
  const totals = await safeQuery<{
    total_messages: string;
    active_participants: string;
  }>(
    `SELECT COUNT(*)::text AS total_messages,
            COUNT(DISTINCT (sender->>'id'))::text AS active_participants
       FROM instinct_teams_channel_messages
       WHERE channel_id = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2`,
    [channelId, windowDays],
  );

  const perDay = await safeQuery<{ day: string; message_count: string }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::text AS message_count
       FROM instinct_teams_channel_messages
       WHERE channel_id = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY date_trunc('day', created_at)
       ORDER BY date_trunc('day', created_at) ASC`,
    [channelId, windowDays],
  );

  const totalRow = totals.rows[0] ?? {
    total_messages: "0",
    active_participants: "0",
  };

  return {
    channel_id: channelId,
    window_days: windowDays,
    total_messages: Number(totalRow.total_messages) || 0,
    active_participants: Number(totalRow.active_participants) || 0,
    messages_per_day: perDay.rows.map((r) => ({
      day: r.day,
      message_count: Number(r.message_count) || 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Mentions for user
// ---------------------------------------------------------------------------

/**
 * Where the user got @-mentioned across their synced channel messages.
 * Urgency score = 0.8 if importance=high, 0.5 if subject starts with
 * URGENT/ASAP/BLOCKER, else 0.25. Simple + deterministic so ranker can
 * reason about it.
 */
export async function getMentionsForUser(
  userId: string,
  windowDays: number = 14,
): Promise<MentionAggregation> {
  const rows = await safeQuery<{
    message_id: string;
    ms_message_id: string;
    channel_id: string;
    channel_name: string;
    team_name: string;
    team_id: string;
    sender: string;
    body: string;
    subject: string | null;
    importance: string;
    created_at: string;
  }>(
    `SELECT m.id AS message_id,
            m.ms_message_id,
            m.channel_id,
            c.display_name AS channel_name,
            t.display_name AS team_name,
            t.id AS team_id,
            m.sender->>'displayName' AS sender,
            m.body,
            m.subject,
            m.importance,
            m.created_at::text AS created_at
       FROM instinct_teams_channel_messages m
       JOIN instinct_teams_channels c ON c.id = m.channel_id
       JOIN instinct_teams_teams t ON t.id = c.team_id
       WHERE t.user_id = $1
         AND m.created_at > NOW() - INTERVAL '1 day' * $2
         AND m.mentions @> jsonb_build_array(jsonb_build_object('mentioned', jsonb_build_object('user', jsonb_build_object('id', $1::text))))
       ORDER BY m.created_at DESC`,
    [userId, windowDays],
  );

  const mentions: ChannelMention[] = rows.rows.map((r) => {
    const importance = (r.importance as "low" | "normal" | "high") || "normal";
    const subject = r.subject ?? "";
    let urgency = 0.25;
    if (importance === "high") urgency = 0.8;
    else if (/^(URGENT|ASAP|BLOCKER)/i.test(subject)) urgency = 0.5;
    const preview = (r.body || "").slice(0, 160);
    return {
      message_id: r.message_id,
      ms_message_id: r.ms_message_id,
      channel_id: r.channel_id,
      channel_name: r.channel_name ?? "",
      team_name: r.team_name ?? "",
      sender: r.sender ?? "Unknown",
      body_preview: preview,
      subject: r.subject,
      importance,
      urgency_score: urgency,
      created_at: new Date(r.created_at).toISOString(),
    };
  });

  const high = mentions.filter((m) => m.importance === "high").length;
  const avg =
    mentions.length > 0
      ? mentions.reduce((s, m) => s + m.urgency_score, 0) / mentions.length
      : 0;

  // Top 5 channels by mention count.
  const byChannel = new Map<
    string,
    { channel_name: string; team_name: string; count: number }
  >();
  for (const m of mentions) {
    const curr = byChannel.get(m.channel_id);
    if (curr) curr.count++;
    else
      byChannel.set(m.channel_id, {
        channel_name: m.channel_name,
        team_name: m.team_name,
        count: 1,
      });
  }
  const top_channels = [...byChannel.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([channel_id, v]) => ({
      channel_id,
      channel_name: v.channel_name,
      team_name: v.team_name,
      mention_count: v.count,
    }));

  return {
    user_id: userId,
    window_days: windowDays,
    total_mentions: mentions.length,
    high_importance_count: high,
    avg_urgency: avg,
    top_channels,
    recent: mentions.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Top active channels
// ---------------------------------------------------------------------------

/**
 * Channels where the user + colleagues have been most active in the
 * window. Ordered by message_count DESC. Returns [] when nothing synced.
 */
export async function getTopActiveChannels(
  userId: string,
  windowDays: number = 14,
  limit: number = 10,
): Promise<TopActiveChannel[]> {
  const { rows } = await safeQuery<{
    channel_id: string;
    channel_name: string;
    team_name: string;
    team_id: string;
    message_count: string;
    participant_count: string;
    last_message_at: string | null;
  }>(
    `SELECT c.id AS channel_id,
            c.display_name AS channel_name,
            t.display_name AS team_name,
            t.id AS team_id,
            COUNT(m.*)::text AS message_count,
            COUNT(DISTINCT (m.sender->>'id'))::text AS participant_count,
            MAX(m.created_at)::text AS last_message_at
       FROM instinct_teams_channels c
       JOIN instinct_teams_teams t ON t.id = c.team_id
       LEFT JOIN instinct_teams_channel_messages m
         ON m.channel_id = c.id
        AND m.created_at > NOW() - INTERVAL '1 day' * $2
       WHERE t.user_id = $1
       GROUP BY c.id, c.display_name, t.display_name, t.id
       HAVING COUNT(m.*) > 0
       ORDER BY COUNT(m.*) DESC
       LIMIT $3`,
    [userId, windowDays, limit],
  );

  return rows.map((r) => ({
    channel_id: r.channel_id,
    channel_name: r.channel_name ?? "",
    team_name: r.team_name ?? "",
    team_id: r.team_id,
    message_count: Number(r.message_count) || 0,
    participant_count: Number(r.participant_count) || 0,
    last_message_at: r.last_message_at
      ? new Date(r.last_message_at).toISOString()
      : null,
  }));
}
