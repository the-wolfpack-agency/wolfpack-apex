/**
 * GET /api/usage — caller's lifetime + 30-day token usage.
 *
 * Sources:
 *   * instinct_messages.tokens_used  — Wolfpack Assistant chat path.
 *     The assistant's `source` column tells us whether each answer
 *     came from AI generation, a cache, or a tool. We count:
 *       - source='ai'                                 → ai_calls
 *       - source IN ('page_facts','knowledge_cache',
 *                    'user_qa_cache')                 → cache_hits
 *   * instinct_events.metadata.prompt_tokens / completion_tokens
 *     emitted from `knowledge.qa_ai_generated` — Support self-serve.
 *     Same path's `knowledge.qa_lookup` rows are counted for
 *     cache_hits when `was_cache_hit` is set.
 *
 * Settings page consumes this to surface the "Token usage" card so
 * users can see what their AI activity is costing in tokens. Cache
 * hits (zero tokens) are counted separately as `cache_hits`.
 *
 * Bug fix 2026-06-01: previously this route counted ai_calls + cache_hits
 * only from `instinct_events`. The Wolfpack Assistant writes to
 * `instinct_messages` (NOT `instinct_events`) so the counters stayed
 * stuck at 0 while tokens_used accumulated — the Settings card read
 * "10,605 tokens • 0 AI calls". Now both stores feed both counters.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { query } from "@/lib/db";

interface UsageWindow {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hits: number;
  ai_calls: number;
}

interface UsageResponse {
  user_id_hint: string;
  lifetime: UsageWindow;
  last_30_days: UsageWindow;
  generated_at: string;
}

const ZERO: UsageWindow = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cache_hits: 0,
  ai_calls: 0,
};

async function readWindow(
  userId: string,
  sinceDays: number | null,
): Promise<UsageWindow> {
  if (!process.env.DATABASE_URL) return { ...ZERO };

  const sinceClause =
    sinceDays != null
      ? `AND timestamp > NOW() - INTERVAL '1 day' * ${Number(sinceDays)}`
      : "";
  const msgClause =
    sinceDays != null
      ? `AND created_at > NOW() - INTERVAL '1 day' * ${Number(sinceDays)}`
      : "";

  let chatTokens = 0;
  let chatAiCalls = 0;
  let chatCacheHits = 0;
  try {
    const r = await query<{
      total: string | null;
      ai_calls: string | null;
      cache_hits: string | null;
    }>(
      `SELECT
         COALESCE(SUM(m.tokens_used), 0)::bigint AS total,
         COUNT(*) FILTER (WHERE m.source = 'ai')::bigint AS ai_calls,
         COUNT(*) FILTER (
           WHERE m.source IN ('page_facts', 'knowledge_cache', 'user_qa_cache')
         )::bigint AS cache_hits
         FROM instinct_messages m
         JOIN instinct_conversations c ON c.id = m.conversation_id
        WHERE c.user_id = $1
          AND m.role = 'assistant'
          ${msgClause}`,
      [userId],
    );
    chatTokens = Number(r.rows[0]?.total ?? 0);
    chatAiCalls = Number(r.rows[0]?.ai_calls ?? 0);
    chatCacheHits = Number(r.rows[0]?.cache_hits ?? 0);
  } catch {
    /* table may be missing in shadow mode — fall through to zero */
  }

  let qaPrompt = 0;
  let qaCompletion = 0;
  let qaCalls = 0;
  let cacheHits = 0;
  try {
    const r = await query<{
      prompt: string | null;
      completion: string | null;
      ai_calls: string | null;
      cache_hits: string | null;
    }>(
      `SELECT
         COALESCE(SUM((metadata->>'prompt_tokens')::bigint), 0)::bigint AS prompt,
         COALESCE(SUM((metadata->>'completion_tokens')::bigint), 0)::bigint AS completion,
         COUNT(*) FILTER (WHERE event_type = 'knowledge.qa_ai_generated')::bigint AS ai_calls,
         COUNT(*) FILTER (
           WHERE event_type = 'knowledge.qa_lookup'
             AND (metadata->>'was_cache_hit') = 'true'
         )::bigint AS cache_hits
       FROM instinct_events
        WHERE user_id = $1
          AND event_type IN ('knowledge.qa_ai_generated', 'knowledge.qa_lookup')
          ${sinceClause}`,
      [userId],
    );
    qaPrompt = Number(r.rows[0]?.prompt ?? 0);
    qaCompletion = Number(r.rows[0]?.completion ?? 0);
    qaCalls = Number(r.rows[0]?.ai_calls ?? 0);
    cacheHits = Number(r.rows[0]?.cache_hits ?? 0);
  } catch {
    /* analytics table missing in shadow mode */
  }

  return {
    prompt_tokens: qaPrompt,
    completion_tokens: qaCompletion,
    total_tokens: chatTokens + qaPrompt + qaCompletion,
    ai_calls: qaCalls + chatAiCalls,
    cache_hits: cacheHits + chatCacheHits,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [lifetime, last30] = await Promise.all([
    readWindow(user.id, null),
    readWindow(user.id, 30),
  ]);

  const body: UsageResponse = {
    user_id_hint: user.id.slice(0, 8),
    lifetime,
    last_30_days: last30,
    generated_at: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
