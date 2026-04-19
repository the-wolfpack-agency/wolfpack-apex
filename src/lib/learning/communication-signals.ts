/**
 * Communication signals — raw extractors over Teams messages + OneNote
 * pages that feed the Wolfpack Assistant's context-awareness.
 *
 * These are pure read helpers (no mutations, no analytics). The Assistant
 * composes them into answers like "you've been emailing X a lot this
 * week" or "you haven't taken notes on Client Y in 30 days".
 */
 

import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommunicationVolume {
  user_id: string;
  window_days: number;
  total_messages: number;
  total_chats: number;
  avg_per_day: number;
}

export interface Collaborator {
  displayName: string;
  email: string | null;
  message_count: number;
}

export interface KnowledgeCoverage {
  user_id: string;
  page_count: number;
  most_recent_modified_at: string | null;
  days_since_last_page: number | null;
  top_topics: string[];
}

// ---------------------------------------------------------------------------
// Communication volume
// ---------------------------------------------------------------------------

export async function getCommunicationVolume(
  userId: string,
  windowDays: number = 30,
): Promise<CommunicationVolume> {
  const result = await safeQuery<{ total_messages: string; total_chats: string }>(
    `SELECT COUNT(*)::text AS total_messages,
            COUNT(DISTINCT chat_id)::text AS total_chats
       FROM instinct_teams_messages
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2`,
    [userId, windowDays],
  );

  const row = result.rows[0] ?? { total_messages: "0", total_chats: "0" };
  const total = Number(row.total_messages) || 0;
  const chats = Number(row.total_chats) || 0;
  return {
    user_id: userId,
    window_days: windowDays,
    total_messages: total,
    total_chats: chats,
    avg_per_day: windowDays > 0 ? total / windowDays : 0,
  };
}

// ---------------------------------------------------------------------------
// Top collaborators
// ---------------------------------------------------------------------------

export async function getTopCollaborators(
  userId: string,
  windowDays: number = 30,
  limit: number = 10,
): Promise<Collaborator[]> {
  const result = await safeQuery<{
    display_name: string;
    email: string | null;
    message_count: string;
  }>(
    `SELECT COALESCE(sender->>'displayName', 'Unknown') AS display_name,
            sender->>'email'                            AS email,
            COUNT(*)::text                              AS message_count
       FROM instinct_teams_messages
       WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY display_name, email
       ORDER BY COUNT(*) DESC
       LIMIT $3`,
    [userId, windowDays, Math.min(Math.max(limit, 1), 100)],
  );

  return result.rows.map((r) => ({
    displayName: r.display_name,
    email: r.email,
    message_count: Number(r.message_count) || 0,
  }));
}

// ---------------------------------------------------------------------------
// Knowledge coverage (OneNote)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "has",
  "into", "are", "was", "were", "our", "not", "but", "you", "your",
  "their", "they", "about", "over", "under", "into", "onto", "page",
  "notes", "meeting", "note", "onenote",
]);

function topTokens(text: string, n: number): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

export async function getKnowledgeCoverage(userId: string): Promise<KnowledgeCoverage> {
  const result = await safeQuery<{
    page_count: string;
    most_recent_modified_at: string | null;
    titles: string[] | null;
  }>(
    `SELECT COUNT(*)::text                                                       AS page_count,
            MAX(modified_at)::text                                               AS most_recent_modified_at,
            ARRAY_AGG(title ORDER BY modified_at DESC)
              FILTER (WHERE title IS NOT NULL)                                   AS titles
       FROM instinct_onenote_pages
       WHERE user_id = $1`,
    [userId],
  );

  const row = result.rows[0];
  const pageCount = Number(row?.page_count) || 0;
  const mostRecent = row?.most_recent_modified_at
    ? new Date(row.most_recent_modified_at).toISOString()
    : null;
  const daysSince =
    mostRecent !== null
      ? Math.floor((Date.now() - new Date(mostRecent).getTime()) / (1000 * 60 * 60 * 24))
      : null;
  const titlesBlob = (row?.titles ?? []).slice(0, 50).join(" ");
  const topTopics = topTokens(titlesBlob, 10);

  return {
    user_id: userId,
    page_count: pageCount,
    most_recent_modified_at: mostRecent,
    days_since_last_page: daysSince,
    top_topics: topTopics,
  };
}
