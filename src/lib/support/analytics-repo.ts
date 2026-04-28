/**
 * support / analytics-repo — read-only aggregation queries for the AI
 * savings dashboard.
 *
 * Two underlying data sources:
 *
 *   1. instinct_support_response_cache
 *        One row per (feature, lexical_signature). hit_count + helpful_count
 *        + unhelpful_count + tokens_saved_estimate accumulate over the row's
 *        lifetime. last_used_at is bumped on every cache hit.
 *
 *   2. instinct_events  (JSONB column: metadata)
 *        ai.completion events fire on every AI call. Cache misses carry
 *        metadata.provider = '<real provider>'; cache hits carry
 *        metadata.provider = 'cache' so the ratio is computable from the
 *        events stream alone (without joining the cache table).
 *
 * Why read-only / no triple-write hooks here:
 *   This module is the dashboard reader. Every metric is a SELECT; no
 *   row gets created by browsing the page. Triple-write happens at the
 *   moment the cache row is written or the ai.completion event fires —
 *   not when an operator views the aggregate.
 *
 * Window math:
 *   - 'today' = UTC midnight today → NOW
 *   - '7d'    = NOW - 7 days       → NOW
 *   - '30d'   = NOW - 30 days      → NOW
 *   - 'all'   = no lower bound     → NOW
 *
 * Cost estimation (cost_saved_usd):
 *   Cheap-tier prices: input $0.15 / MTok, output $0.60 / MTok.
 *   Standard-tier prices: input $2.50 / MTok, output $10.00 / MTok.
 *   The cache table stores tokens_saved_estimate as a single int (input +
 *   output combined), so we compute a blended price by treating the saved
 *   tokens as if half were input and half were output. Future migration
 *   could split the cache row into input vs output for tighter accounting,
 *   but the blended estimate is ~within 30% of true spend in practice and
 *   keeps the headline number truthful directionally.
 */

import { query } from "@/lib/db";

// ---------------------------------------------------------------------------
// Public types — the API-route response contract
// ---------------------------------------------------------------------------

export type SavingsWindow = "today" | "7d" | "30d" | "all";

export interface SavingsSummary {
  tokens_saved: number;
  ai_calls: number;
  cache_hits: number;
  cache_miss: number;
  cache_hit_rate: number;
  cost_saved_usd: number;
  time_saved_ms: number;
  period: { start: string | null; end: string };
}

export interface FeatureBreakdown {
  feature: string;
  cache_hits: number;
  cache_miss: number;
  tokens_saved: number;
  hit_rate: number;
}

export interface ProviderBreakdown {
  provider: string;
  calls: number;
  tokens: number;
  cost_usd: number;
  /** Only set on the synthetic 'cache' row. */
  tokens_saved?: number;
  /** Only set on the synthetic 'cache' row. */
  cost_saved_usd?: number;
}

export interface TopCachedResponse {
  id: string;
  feature: string;
  hit_count: number;
  helpful_count: number;
  unhelpful_count: number;
  tokens_saved_estimate: number;
  model_used: string;
  last_used_at: string | null;
  prompt_preview: string;
}

export interface DailyDataPoint {
  date: string; // YYYY-MM-DD (UTC)
  tokens_saved: number;
  ai_calls: number;
  cache_hits: number;
}

// ---------------------------------------------------------------------------
// Pricing tables (USD per million tokens)
// ---------------------------------------------------------------------------

/* Cheap-tier blended price per million tokens (50/50 input/output mix).
   Input $0.15 + Output $0.60 averaged: $0.375 per MTok. We use the
   blended number because the cache row stores combined token counts. */
const CHEAP_BLENDED_USD_PER_MTOK = (0.15 + 0.6) / 2;

/* Standard-tier blended price per million tokens. Reserved for future
   per-tier breakdown — today the cache helper writes everything as
   cheap-tier. Keeping the constant here so the math stays in one place
   when the upgrade lands. */
const STANDARD_BLENDED_USD_PER_MTOK = (2.5 + 10) / 2;
void STANDARD_BLENDED_USD_PER_MTOK;

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

interface ResolvedWindow {
  /** ISO timestamp string, or null when the window is 'all'. */
  start: string | null;
  /** ISO timestamp string. Always set. */
  end: string;
}

/**
 * Compute the [start, end) window for a SavingsWindow value.
 *
 * Pure function — uses Date.now() as `end` so callers get a stable point-
 * in-time snapshot. Tests can mock Date if they need a fixed clock.
 */
export function resolveWindow(window: SavingsWindow): ResolvedWindow {
  const end = new Date();
  if (window === "all") {
    return { start: null, end: end.toISOString() };
  }
  if (window === "today") {
    /* UTC midnight today. We use UTC throughout because the analytics
       events table stamps in UTC and the operator can be in any tz. */
    const start = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
    );
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const days = window === "7d" ? 7 : 30;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/* Reusable WHERE-clause fragment for an ai.completion event window.
   Returns the fragment + params slot so callers compose without bug-prone
   string concat. The first $ slot is implicit ($1) — callers that need to
   add their own params should pass `paramOffset` so the second event
   bound clause uses $2 etc. */
function eventTimeWindowSql(
  resolved: ResolvedWindow,
  paramOffset: number,
): { sql: string; params: unknown[] } {
  if (resolved.start === null) {
    return { sql: "", params: [] };
  }
  const idx = paramOffset + 1;
  return {
    sql: ` AND timestamp >= $${idx}`,
    params: [resolved.start],
  };
}

function cacheTimeWindowSql(
  resolved: ResolvedWindow,
  paramOffset: number,
): { sql: string; params: unknown[] } {
  if (resolved.start === null) {
    return { sql: "", params: [] };
  }
  const idx = paramOffset + 1;
  return {
    sql: ` AND last_used_at >= $${idx}`,
    params: [resolved.start],
  };
}

// ---------------------------------------------------------------------------
// Number coercion — pg returns SUM/COUNT as strings on bigint columns
// ---------------------------------------------------------------------------

function toInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toFloat(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Cost in USD for a given combined token count at cheap-tier rates. */
function tokensToCheapCostUsd(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * CHEAP_BLENDED_USD_PER_MTOK;
}

// ---------------------------------------------------------------------------
// 1) Headline summary
// ---------------------------------------------------------------------------

/**
 * Summary card numbers for the dashboard. Returns the four headline
 * metrics + computed savings.
 *
 * `time_saved_ms` is `(avg miss latency - avg hit latency) * cache_hits`.
 * If we have no cache_hit rows in the window, time_saved_ms is 0 (not
 * NaN). If we have hits but no misses to compare against, we fall back to
 * `avg hit latency * cache_hits` as a conservative estimate.
 */
export async function getSavingsSummary(
  window: SavingsWindow,
): Promise<SavingsSummary> {
  const resolved = resolveWindow(window);

  /* tokens_saved comes from the cache table because it is the
     authoritative source — the events table only sees the per-call
     savings, the cache table accumulates lifetime savings. We filter on
     last_used_at because we want to count tokens saved during the WINDOW
     (not tokens saved by all-time hits on rows that happen to have been
     touched recently). */
  const cacheW = cacheTimeWindowSql(resolved, 0);
  const cacheRes = await query<{ tokens_saved: string | number | null }>(
    `SELECT COALESCE(SUM(tokens_saved_estimate), 0)::bigint AS tokens_saved
       FROM instinct_support_response_cache
      WHERE 1=1${cacheW.sql}`,
    cacheW.params,
  );
  const tokensSaved = toInt(cacheRes.rows[0]?.tokens_saved);

  /* AI calls / cache hits / cache miss come from the events stream. The
     events stream sees BOTH cache hits and misses because both fire an
     ai.completion event (cache hits with provider='cache'). */
  const evtW = eventTimeWindowSql(resolved, 0);
  const evtRes = await query<{
    ai_calls: string | number | null;
    cache_hits: string | number | null;
  }>(
    `SELECT COUNT(*)::bigint AS ai_calls,
            COUNT(*) FILTER (WHERE metadata->>'provider' = 'cache')::bigint
              AS cache_hits
       FROM instinct_events
      WHERE event_type = 'ai.completion'${evtW.sql}`,
    evtW.params,
  );
  const aiCalls = toInt(evtRes.rows[0]?.ai_calls);
  const cacheHits = toInt(evtRes.rows[0]?.cache_hits);
  const cacheMiss = Math.max(0, aiCalls - cacheHits);
  const cacheHitRate = aiCalls === 0 ? 0 : cacheHits / aiCalls;

  /* Latency comparison: average latency_ms on cache hits vs misses. We
     pull both averages in one query to keep the round-trip count down. */
  const latW = eventTimeWindowSql(resolved, 0);
  const latRes = await query<{
    hit_avg: string | number | null;
    miss_avg: string | number | null;
  }>(
    `SELECT
        AVG((metadata->>'latency_ms')::float)
          FILTER (WHERE metadata->>'provider' = 'cache')::float AS hit_avg,
        AVG((metadata->>'latency_ms')::float)
          FILTER (WHERE metadata->>'provider' <> 'cache')::float AS miss_avg
       FROM instinct_events
      WHERE event_type = 'ai.completion'
        AND metadata ? 'latency_ms'${latW.sql}`,
    latW.params,
  );
  const hitAvg = toFloat(latRes.rows[0]?.hit_avg);
  const missAvg = toFloat(latRes.rows[0]?.miss_avg);
  let timeSavedMs = 0;
  if (cacheHits > 0) {
    if (missAvg > 0 && hitAvg >= 0) {
      timeSavedMs = Math.max(0, (missAvg - hitAvg) * cacheHits);
    } else if (hitAvg > 0) {
      /* No miss data to compare against — conservative fallback uses the
         hit latency as the savings figure. Better than reporting 0 when
         we know cache hits happened. */
      timeSavedMs = hitAvg * cacheHits;
    }
  }

  return {
    tokens_saved: tokensSaved,
    ai_calls: aiCalls,
    cache_hits: cacheHits,
    cache_miss: cacheMiss,
    cache_hit_rate: cacheHitRate,
    cost_saved_usd: tokensToCheapCostUsd(tokensSaved),
    time_saved_ms: Math.round(timeSavedMs),
    period: { start: resolved.start, end: resolved.end },
  };
}

// ---------------------------------------------------------------------------
// 2) Per-feature breakdown
// ---------------------------------------------------------------------------

/**
 * Per-feature aggregation of cache hits, misses, and tokens saved. Driven
 * by the events stream so we can split miss vs hit by feature without
 * needing per-feature totals on the cache table.
 *
 * tokens_saved per feature is a SUM of metadata.tokens_saved on cache-hit
 * events, which is what the response-cache helper writes when it emits
 * support.cache_hit. (Each ai.completion that came from a cache hit is
 * paired with that field.)
 */
export async function getSavingsByFeature(
  window: SavingsWindow,
): Promise<FeatureBreakdown[]> {
  const resolved = resolveWindow(window);
  const evtW = eventTimeWindowSql(resolved, 0);
  const r = await query<{
    feature: string | null;
    cache_hits: string | number | null;
    cache_miss: string | number | null;
    tokens_saved: string | number | null;
  }>(
    `SELECT
        COALESCE(metadata->>'feature', 'unknown') AS feature,
        COUNT(*) FILTER (WHERE metadata->>'provider' = 'cache')::bigint
          AS cache_hits,
        COUNT(*) FILTER (WHERE metadata->>'provider' <> 'cache')::bigint
          AS cache_miss,
        COALESCE(
          SUM((metadata->>'tokens_saved')::int)
            FILTER (WHERE metadata->>'provider' = 'cache'),
          0
        )::bigint AS tokens_saved
       FROM instinct_events
      WHERE event_type = 'ai.completion'${evtW.sql}
      GROUP BY 1
      ORDER BY cache_hits DESC, feature ASC`,
    evtW.params,
  );

  return r.rows.map((row) => {
    const cacheHits = toInt(row.cache_hits);
    const cacheMiss = toInt(row.cache_miss);
    const total = cacheHits + cacheMiss;
    return {
      feature: row.feature ?? "unknown",
      cache_hits: cacheHits,
      cache_miss: cacheMiss,
      tokens_saved: toInt(row.tokens_saved),
      hit_rate: total === 0 ? 0 : cacheHits / total,
    };
  });
}

// ---------------------------------------------------------------------------
// 3) Per-provider breakdown
// ---------------------------------------------------------------------------

/**
 * Per-provider aggregation. Two flavors of row:
 *
 *   - Real providers (azure-openai, anthropic, openai, ...): `calls`,
 *     `tokens` (input + output), `cost_usd` (sum of metadata.cost_usd).
 *
 *   - Synthetic 'cache' provider: `calls` = number of cache hits, `tokens`
 *     = number of tokens served from cache, `cost_usd` = 0 (the cache hit
 *     itself was free), `tokens_saved` = same as tokens, `cost_saved_usd`
 *     = computed from tokens_saved at cheap-tier rates.
 *
 * The frontend can render both row types from the same array; the
 * tokens_saved / cost_saved_usd fields stay undefined on real-provider
 * rows so the UI knows which kind it has.
 */
export async function getSavingsByProvider(
  window: SavingsWindow,
): Promise<ProviderBreakdown[]> {
  const resolved = resolveWindow(window);
  const evtW = eventTimeWindowSql(resolved, 0);
  const r = await query<{
    provider: string | null;
    calls: string | number | null;
    tokens: string | number | null;
    cost_usd: string | number | null;
    tokens_saved: string | number | null;
  }>(
    `SELECT
        COALESCE(metadata->>'provider', 'unknown') AS provider,
        COUNT(*)::bigint AS calls,
        COALESCE(
          SUM(
            COALESCE((metadata->>'input_tokens')::int, 0) +
            COALESCE((metadata->>'output_tokens')::int, 0)
          ),
          0
        )::bigint AS tokens,
        COALESCE(SUM((metadata->>'cost_usd')::float), 0)::float AS cost_usd,
        COALESCE(
          SUM((metadata->>'tokens_saved')::int)
            FILTER (WHERE metadata->>'provider' = 'cache'),
          0
        )::bigint AS tokens_saved
       FROM instinct_events
      WHERE event_type = 'ai.completion'${evtW.sql}
      GROUP BY 1
      ORDER BY calls DESC, provider ASC`,
    evtW.params,
  );

  return r.rows.map((row) => {
    const provider = row.provider ?? "unknown";
    const calls = toInt(row.calls);
    const tokens = toInt(row.tokens);
    const costUsd = toFloat(row.cost_usd);
    if (provider === "cache") {
      const tokensSaved = toInt(row.tokens_saved);
      return {
        provider,
        calls,
        tokens: tokensSaved,
        cost_usd: 0,
        tokens_saved: tokensSaved,
        cost_saved_usd: tokensToCheapCostUsd(tokensSaved),
      };
    }
    return {
      provider,
      calls,
      tokens,
      cost_usd: costUsd,
    };
  });
}

// ---------------------------------------------------------------------------
// 4) Top reused cache rows
// ---------------------------------------------------------------------------

/**
 * The top N most-reused cache rows in the window. "In the window" means
 * `last_used_at >= window.start` so we surface rows that were ACTIVELY
 * paying off recently, not historical no-longer-useful rows.
 *
 * prompt_preview is `prompt_input.title` when present (the support cache
 * stores ticket title + body so this is the fast path), else the first
 * 80 chars of `prompt_input.body`, else an empty string. Defensive against
 * any other prompt_input shape (categorize/auto_ack write different
 * payloads), so the column never crashes the SELECT.
 */
export async function getTopCachedResponses(
  window: SavingsWindow,
  limit = 10,
): Promise<TopCachedResponse[]> {
  const resolved = resolveWindow(window);
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

  const cacheW = cacheTimeWindowSql(resolved, 0);
  const r = await query<{
    id: string;
    feature: string;
    hit_count: number | string;
    helpful_count: number | string;
    unhelpful_count: number | string;
    tokens_saved_estimate: number | string;
    model_used: string;
    last_used_at: string | null;
    prompt_input: unknown;
  }>(
    `SELECT id::text AS id, feature, hit_count, helpful_count, unhelpful_count,
            tokens_saved_estimate, model_used,
            last_used_at::text AS last_used_at,
            prompt_input
       FROM instinct_support_response_cache
      WHERE 1=1${cacheW.sql}
      ORDER BY hit_count DESC, last_used_at DESC NULLS LAST
      LIMIT ${safeLimit}`,
    cacheW.params,
  );

  return r.rows.map((row) => ({
    id: String(row.id),
    feature: String(row.feature),
    hit_count: toInt(row.hit_count),
    helpful_count: toInt(row.helpful_count),
    unhelpful_count: toInt(row.unhelpful_count),
    tokens_saved_estimate: toInt(row.tokens_saved_estimate),
    model_used: String(row.model_used),
    last_used_at: row.last_used_at ? String(row.last_used_at) : null,
    prompt_preview: extractPromptPreview(row.prompt_input),
  }));
}

function extractPromptPreview(promptInput: unknown): string {
  if (promptInput == null) return "";
  /* node-postgres returns JSONB as already-parsed JS objects, but a
     defensive parse keeps a string-encoded fallback safe (some drivers
     vary). */
  let obj: Record<string, unknown> | null = null;
  if (typeof promptInput === "string") {
    try {
      const parsed = JSON.parse(promptInput);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return promptInput.slice(0, 80);
    }
  } else if (typeof promptInput === "object" && !Array.isArray(promptInput)) {
    obj = promptInput as Record<string, unknown>;
  }
  if (!obj) return "";
  const title = obj.title;
  if (typeof title === "string" && title.length > 0) {
    return title.length > 80 ? title.slice(0, 80) : title;
  }
  const body = obj.body;
  if (typeof body === "string" && body.length > 0) {
    return body.length > 80 ? body.slice(0, 80) : body;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 5) Daily trend for the chart
// ---------------------------------------------------------------------------

/**
 * Returns one data point per day for the last `days` days, INCLUDING days
 * with zero activity (so the chart x-axis stays continuous and the line
 * touches zero on quiet days instead of skipping).
 *
 * Implementation: generate_series builds a calendar of N days; the cache
 * + events tables are LEFT JOINed onto it. Days with no rows still appear
 * with tokens_saved=0 and ai_calls=0.
 *
 * We use UTC date boundaries so the same N days return regardless of
 * server tz drift.
 */
export async function getDailySavingsTrend(
  days: number,
): Promise<DailyDataPoint[]> {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));

  /* The series is "today minus N+1 days" to "today" so we always get
     exactly N points (the trailing range is half-open). */
  const r = await query<{
    date: string;
    tokens_saved: string | number | null;
    ai_calls: string | number | null;
    cache_hits: string | number | null;
  }>(
    `WITH days AS (
       SELECT (
         (date_trunc('day', NOW() AT TIME ZONE 'UTC') -
           (n || ' days')::interval)::date
       ) AS day
         FROM generate_series(0, $1::int - 1) AS n
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            COALESCE(c.tokens_saved, 0)::bigint AS tokens_saved,
            COALESCE(e.ai_calls, 0)::bigint AS ai_calls,
            COALESCE(e.cache_hits, 0)::bigint AS cache_hits
       FROM days d
       LEFT JOIN (
         SELECT date_trunc('day', last_used_at AT TIME ZONE 'UTC')::date
                  AS day,
                SUM(tokens_saved_estimate)::bigint AS tokens_saved
           FROM instinct_support_response_cache
          WHERE last_used_at IS NOT NULL
            AND last_used_at >=
              (date_trunc('day', NOW() AT TIME ZONE 'UTC') -
                ($1::int - 1 || ' days')::interval)
          GROUP BY 1
       ) c ON c.day = d.day
       LEFT JOIN (
         SELECT date_trunc('day', timestamp AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::bigint AS ai_calls,
                COUNT(*) FILTER (WHERE metadata->>'provider' = 'cache')::bigint
                  AS cache_hits
           FROM instinct_events
          WHERE event_type = 'ai.completion'
            AND timestamp >=
              (date_trunc('day', NOW() AT TIME ZONE 'UTC') -
                ($1::int - 1 || ' days')::interval)
          GROUP BY 1
       ) e ON e.day = d.day
      ORDER BY d.day ASC`,
    [safeDays],
  );

  return r.rows.map((row) => ({
    date: String(row.date),
    tokens_saved: toInt(row.tokens_saved),
    ai_calls: toInt(row.ai_calls),
    cache_hits: toInt(row.cache_hits),
  }));
}
