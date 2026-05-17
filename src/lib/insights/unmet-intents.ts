/**
 * Unmet-intent insight aggregator.
 *
 * Reads `assistant.intent_unmatched` events from instinct_events and
 * clusters them so the admin dashboard can show a ranked backlog of
 * phrasings we should build deterministic tools for.
 *
 * Clustering strategy (v1, deliberately simple):
 *   - Lowercase + strip trailing punctuation
 *   - Collapse runs of whitespace to a single space
 *   - Group by the normalized text, count occurrences, sort by count desc
 *
 * Why simple: the first useful read is "show me the 20 most-typed
 * phrases that fell through to the LLM in the last 7 days." Semantic
 * clustering (embeddings) is a v2 — once we have enough data to
 * justify it, the same backlog query produces the candidate set.
 */

import { safeQuery } from "@/lib/db";

export interface UnmetIntent {
  /** Normalized phrase used for grouping. */
  normalizedText: string;
  /** A representative raw phrasing (most-recent). Useful for the
   *  admin view so we surface the user's actual words, not the
   *  whitespace-collapsed version. */
  exampleText: string;
  count: number;
  /** Most recent ISO timestamp this phrase appeared. */
  lastSeenAt: string;
  /** Distinct user count — a phrase from 3 different users is a
   *  stronger backlog signal than the same user repeating it. */
  distinctUsers: number;
  /** Average has_brain_context across hits — high means the LLM had
   *  something to fall back on; low means we were probably blind. */
  brainContextRate: number;
}

export interface UnmetIntentsQuery {
  /** How far back to look. Default 7d. */
  sinceHours?: number;
  /** Max rows to return. Default 50. */
  limit?: number;
  /** Drop phrases shorter than this many chars (filters out "ok",
   *  "yes", and other chat-noise). Default 6. */
  minLength?: number;
}

export function normalizePhrase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[?.!,;:]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getUnmetIntents(
  opts: UnmetIntentsQuery = {},
): Promise<UnmetIntent[]> {
  if (!process.env.DATABASE_URL) return [];
  const sinceHours = opts.sinceHours ?? 24 * 7;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const minLength = opts.minLength ?? 6;

  try {
    /* We pull raw rows + normalize in JS rather than via SQL regex
     * functions so the grouping stays portable across managed
     * Postgres tiers. The volume is low (1 row per fallthrough);
     * even at 10k events/day this fits in memory trivially. */
    const r = await safeQuery<{
      message_text: string;
      user_id: string;
      timestamp: string;
      has_brain_context: boolean | null;
    }>(
      `SELECT
         (metadata->>'message_text') AS message_text,
         user_id,
         timestamp::text AS timestamp,
         (metadata->>'has_brain_context')::boolean AS has_brain_context
       FROM instinct_events
       WHERE event_type = 'assistant.intent_unmatched'
         AND timestamp > NOW() - INTERVAL '1 hour' * $1
         AND metadata->>'message_text' IS NOT NULL
       ORDER BY timestamp DESC`,
      [sinceHours],
    );

    /* Cluster in JS. Map: normalized → bucket. */
    interface Bucket {
      normalized: string;
      example: string;
      userIds: Set<string>;
      brainHits: number;
      total: number;
      lastSeen: string;
    }
    const buckets = new Map<string, Bucket>();
    for (const row of r.rows) {
      const raw = (row.message_text ?? "").toString();
      if (raw.length < minLength) continue;
      const norm = normalizePhrase(raw);
      if (!norm) continue;
      const bucket = buckets.get(norm) ?? {
        normalized: norm,
        example: raw,
        userIds: new Set<string>(),
        brainHits: 0,
        total: 0,
        lastSeen: row.timestamp,
      };
      bucket.userIds.add(row.user_id);
      bucket.total += 1;
      if (row.has_brain_context === true) bucket.brainHits += 1;
      /* timestamps come back DESC so the first occurrence per bucket
       * is the most-recent; don't overwrite. */
      if (!buckets.has(norm)) bucket.lastSeen = row.timestamp;
      buckets.set(norm, bucket);
    }

    const out: UnmetIntent[] = [];
    for (const b of buckets.values()) {
      out.push({
        normalizedText: b.normalized,
        exampleText: b.example,
        count: b.total,
        lastSeenAt: b.lastSeen,
        distinctUsers: b.userIds.size,
        brainContextRate: b.total > 0 ? b.brainHits / b.total : 0,
      });
    }
    /* Sort by distinct-user count first, then total count — a phrase
     * 10 different users typed once beats the same user typing the
     * same phrase 10 times. */
    out.sort((a, b) =>
      b.distinctUsers - a.distinctUsers || b.count - a.count,
    );
    return out.slice(0, limit);
  } catch (err) {
    console.warn("[insights/unmet-intents] query failed:", (err as Error).message);
    return [];
  }
}
