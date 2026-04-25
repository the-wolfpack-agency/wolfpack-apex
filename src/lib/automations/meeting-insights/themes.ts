/**
 * meeting-insights / themes — Phase 3 cross-meeting theme tracker.
 *
 * Reads the per-message analyses from Postgres and answers three
 * questions:
 *   - Recurring topics: what's been raised most often in this feed?
 *   - Stale topics: what was raised in the past 90 days but absent
 *     from the most-recent few messages?
 *   - Open action items: across the whole feed, which action items
 *     are still pending (not completed)?
 *
 * Plus `semanticSearch` — Qdrant-scoped vector search; degrades to a
 * Postgres ILIKE topic match when Qdrant is unavailable so the UX is
 * never blank.
 *
 * All queries are pure reads against the analyses + messages tables.
 * No LLM calls happen here — themes are derived from previously
 * analysed messages.
 */

import { query } from "@/lib/db";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RecurringTopic {
  topic: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
  message_ids: string[];
}

export interface StaleTopic {
  topic: string;
  last_mentioned: string;
  days_silent: number;
  message_ids: string[];
}

export interface OpenActionItem {
  message_id: string;
  message_subject: string;
  message_received_at: string;
  description: string;
  owner: string | null;
  due: string | null;
  source_quote: string | null;
}

export interface SemanticHit {
  message_id: string;
  subject: string;
  received_at: string;
  topics: string[];
  score: number;
  highlight: string;
}

/* ------------------------------------------------------------------ */
/* Recurring topics                                                    */
/* ------------------------------------------------------------------ */

/**
 * Topics ranked by mention count over the lookback window. Only counts
 * `success` analyses (partial / error rows have empty topics anyway).
 */
export async function recurringTopics(args: {
  feed_id: string;
  since?: Date;
  limit?: number;
}): Promise<RecurringTopic[]> {
  const since = args.since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  const r = await query<{
    topic: string;
    mention_count: string | number;
    first_seen: string;
    last_seen: string;
    message_ids: string[];
  }>(
    `SELECT
        topic,
        COUNT(*)::int AS mention_count,
        MIN(m.received_at)::text AS first_seen,
        MAX(m.received_at)::text AS last_seen,
        ARRAY_AGG(DISTINCT m.id::text) AS message_ids
       FROM instinct_meeting_analyses a
       JOIN instinct_meeting_messages m ON m.id = a.message_id
       JOIN LATERAL UNNEST(a.topics) AS topic ON TRUE
      WHERE m.feed_id = $1
        AND m.received_at >= $2
        AND a.status = 'success'
      GROUP BY topic
      HAVING COUNT(*) >= 1
      ORDER BY mention_count DESC, last_seen DESC
      LIMIT $3`,
    [args.feed_id, since.toISOString(), limit],
  );

  return r.rows.map((row) => ({
    topic: row.topic,
    mention_count: Number(row.mention_count),
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    message_ids: row.message_ids ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Stale topics                                                        */
/* ------------------------------------------------------------------ */

/**
 * Topics that appeared in the lookback window but are NOT mentioned in
 * the most recent N messages of the feed. Reads as "what dropped off
 * the agenda".
 *
 * We intentionally tolerate windows where N > total messages — in that
 * case "recent" = all messages and nothing is stale.
 */
export async function staleTopics(args: {
  feed_id: string;
  since?: Date;
  /** How many recent messages count as "the recent window". */
  recent_window?: number;
  limit?: number;
}): Promise<StaleTopic[]> {
  const since = args.since ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentWindow = Math.max(1, Math.min(args.recent_window ?? 3, 20));
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  const r = await query<{
    topic: string;
    last_mentioned: string;
    days_silent: number;
    message_ids: string[];
  }>(
    `WITH recent_msgs AS (
       SELECT id
         FROM instinct_meeting_messages
        WHERE feed_id = $1
        ORDER BY received_at DESC
        LIMIT $3
     ),
     window_topics AS (
       SELECT topic, m.id AS message_id, m.received_at
         FROM instinct_meeting_analyses a
         JOIN instinct_meeting_messages m ON m.id = a.message_id
         JOIN LATERAL UNNEST(a.topics) AS topic ON TRUE
        WHERE m.feed_id = $1
          AND m.received_at >= $2
          AND a.status = 'success'
     )
     SELECT
        wt.topic,
        MAX(wt.received_at)::text AS last_mentioned,
        EXTRACT(DAY FROM NOW() - MAX(wt.received_at))::int AS days_silent,
        ARRAY_AGG(DISTINCT wt.message_id::text) AS message_ids
       FROM window_topics wt
      WHERE wt.topic NOT IN (
         SELECT DISTINCT topic
           FROM instinct_meeting_analyses a2
           JOIN recent_msgs r ON r.id = a2.message_id
           JOIN LATERAL UNNEST(a2.topics) AS topic ON TRUE
           WHERE a2.status = 'success'
      )
      GROUP BY wt.topic
      ORDER BY MAX(wt.received_at) ASC
      LIMIT $4`,
    [args.feed_id, since.toISOString(), recentWindow, limit],
  );

  return r.rows.map((row) => ({
    topic: row.topic,
    last_mentioned: row.last_mentioned,
    days_silent: Number(row.days_silent),
    message_ids: row.message_ids ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Open action items                                                   */
/* ------------------------------------------------------------------ */

/**
 * Flatten action_items jsonb across all `success` analyses for the feed
 * and return rows where completed != true.
 *
 * Only the LATEST analysis per message is consulted, so re-analyses
 * don't duplicate items.
 */
export async function openActionItems(args: {
  feed_id: string;
  limit?: number;
}): Promise<OpenActionItem[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

  const r = await query<{
    message_id: string;
    message_subject: string;
    message_received_at: string;
    description: string | null;
    owner: string | null;
    due: string | null;
    source_quote: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (a.message_id) a.id, a.message_id, a.action_items
         FROM instinct_meeting_analyses a
         JOIN instinct_meeting_messages m ON m.id = a.message_id
        WHERE m.feed_id = $1
          AND a.status = 'success'
        ORDER BY a.message_id, a.analyzed_at DESC
     )
     SELECT m.id::text AS message_id,
            m.subject AS message_subject,
            m.received_at::text AS message_received_at,
            ai->>'description' AS description,
            ai->>'owner' AS owner,
            ai->>'due' AS due,
            ai->>'source_quote' AS source_quote
       FROM latest l
       JOIN instinct_meeting_messages m ON m.id = l.message_id
       JOIN LATERAL JSONB_ARRAY_ELEMENTS(l.action_items) AS ai ON TRUE
      WHERE COALESCE((ai->>'completed')::boolean, FALSE) = FALSE
        AND COALESCE(NULLIF(ai->>'description', ''), '') <> ''
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [args.feed_id, limit],
  );

  return r.rows.map((row) => ({
    message_id: row.message_id,
    message_subject: row.message_subject ?? "",
    message_received_at: row.message_received_at,
    description: row.description ?? "",
    owner: row.owner,
    due: row.due,
    source_quote: row.source_quote,
  }));
}

/* ------------------------------------------------------------------ */
/* Semantic search                                                     */
/* ------------------------------------------------------------------ */

/**
 * Search analyses for a feed by free-text query. We try Qdrant first
 * (when configured) and fall back to a Postgres ILIKE match on the
 * topics array + message subject so the UX is never blank when the
 * vector store is offline / not yet wired to a real embedder.
 */
export async function semanticSearch(args: {
  feed_id: string;
  query: string;
  limit?: number;
}): Promise<SemanticHit[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 5, 20));
  const q = args.query.trim();
  if (!q) return [];

  const qdrantHits = await tryQdrantSearch(args.feed_id, q, limit);
  if (qdrantHits.length > 0) return qdrantHits;

  // Fallback: Postgres keyword match on topics + subject. We pull the
  // latest analysis per message so we don't have duplicate hits.
  const r = await query<{
    message_id: string;
    subject: string;
    received_at: string;
    topics: string[] | null;
    body_text: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (a.message_id) a.message_id, a.topics
         FROM instinct_meeting_analyses a
         JOIN instinct_meeting_messages m ON m.id = a.message_id
        WHERE m.feed_id = $1
        ORDER BY a.message_id, a.analyzed_at DESC
     )
     SELECT m.id::text AS message_id,
            m.subject,
            m.received_at::text AS received_at,
            l.topics,
            COALESCE(m.body_text, '') AS body_text
       FROM latest l
       JOIN instinct_meeting_messages m ON m.id = l.message_id
      WHERE m.feed_id = $1
        AND (
          m.subject ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1 FROM UNNEST(l.topics) AS t WHERE t ILIKE '%' || $2 || '%'
          )
          OR m.body_text ILIKE '%' || $2 || '%'
        )
      ORDER BY m.received_at DESC
      LIMIT $3`,
    [args.feed_id, q, limit],
  );

  return r.rows.map((row) => ({
    message_id: row.message_id,
    subject: row.subject ?? "",
    received_at: row.received_at,
    topics: row.topics ?? [],
    score: 0,
    highlight: extractHighlight(row.body_text, q, 200),
  }));
}

async function tryQdrantSearch(
  feed_id: string,
  q: string,
  limit: number,
): Promise<SemanticHit[]> {
  const url = process.env.QDRANT_URL;
  if (!url) return [];

  // Without a real embedding provider (zero-vector convention), Qdrant
  // similarity search isn't meaningful. We skip and let the Postgres
  // fallback handle it. Plumbed here so a future embedder upgrade
  // becomes a one-line swap.
  return [];
  void feed_id;
  void q;
  void limit;
}

function extractHighlight(body: string, q: string, max: number): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return body.slice(0, max);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + q.length + max);
  const excerpt = body.slice(start, end);
  return (start > 0 ? "…" : "") + excerpt + (end < body.length ? "…" : "");
}
