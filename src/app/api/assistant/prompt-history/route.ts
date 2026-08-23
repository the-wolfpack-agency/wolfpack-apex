/**
 * GET /api/assistant/prompt-history — recent user prompts for the
 * caller, surfaced by the in-chat history overlay.
 *
 * Source: `instinct_messages.role = 'user'` joined to
 * `instinct_conversations` so we only return prompts owned by the
 * caller. We dedupe by trimmed content (keeping the most-recent
 * timestamp per prompt) so a user who asked the same question three
 * times in a row gets one row, not three. Cap at `?limit=` (default
 * 20, max 50) so the overlay stays compact.
 *
 * Why this exists: the conversations sidebar is hidden by default
 * (the 2026-05-24 decision) and we removed server-side auto-resume of
 * the most-recent thread. Users still want to see what they've asked
 * before — to repeat a useful query, or to remember how they phrased
 * something. The overlay surfaces that without bringing the sidebar
 * back.
 *
 * Response shape (200):
 *   { prompts: [{ content, last_asked_at, ask_count }] }
 *
 * Auth: 401 without a valid Instinct JWT. Graceful degradation
 * when the table isn't present (shadow / preview): empty list.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { query } from "@/lib/db";

interface HistoryRow {
  content: string;
  last_asked_at: string;
  ask_count: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/* Drop prompts shorter than this — single-character pokes and
 * "ok" / "?" rows would dominate the list. */
const MIN_PROMPT_CHARS = 3;
/* Truncate long prompts in the response — the overlay shows a
 * one-liner with overflow ellipsis. Full content lives in the
 * conversations table; the overlay only needs enough to recognize
 * + reuse. Mirrors the cap the inline AI-draft / clarify-chip
 * payloads use elsewhere. */
const PREVIEW_CHARS = 240;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ prompts: [] });
  }

  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  try {
    const r = await query<{
      content: string;
      last_asked_at: Date | string;
      ask_count: string | number;
    }>(
      /* Group by trimmed content so repeats collapse. ROW_NUMBER
       * isn't needed; MAX(created_at) on the grouped key gives the
       * most-recent ask, COUNT(*) gives repeats. ORDER BY
       * most-recent so the overlay shows newest first. */
      /* WHEN THIS PERSON ASKED IT, not when it was last sent.
       *
       * Reported 2026-08-23: prompts last typed days earlier were all showing
       * as minutes old. The timestamps were real, which is what made it
       * confusing, and the raw MAX was still the wrong number to show.
       *
       * The give-away is in the shape of the traffic. The asks behind those
       * timestamps arrived two and three seconds apart, each in its own new
       * conversation, thirteen of them inside a minute. Nobody types like
       * that. Whatever produced them, a click-through, a replay, an automated
       * pass, it is not the person remembering what they were working on, and
       * it is their memory this panel exists to serve.
       *
       * So an ask counts as DELIBERATE when at least ten seconds passed since
       * that person's previous ask. A prompt's timestamp is the most recent
       * deliberate one, and the raw maximum only when there is none, so a
       * prompt never vanishes and never shows nothing.
       *
       * The count still counts everything: 136 asks is 136 asks however they
       * arrived. Only the CLOCK is corrected, because that is the part that was
       * telling somebody a false thing about their own week. */
      `WITH asks AS (
         SELECT BTRIM(m.content) AS content,
                m.created_at,
                m.created_at - LAG(m.created_at) OVER (ORDER BY m.created_at) AS gap
           FROM instinct_messages m
           JOIN instinct_conversations c ON c.id = m.conversation_id
          WHERE c.user_id = $1
            AND m.role = 'user'
            AND LENGTH(BTRIM(m.content)) >= $2
       )
       SELECT content,
              COALESCE(
                MAX(created_at) FILTER (WHERE gap IS NULL OR gap > INTERVAL '10 seconds'),
                MAX(created_at)
              ) AS last_asked_at,
              COUNT(*)::int AS ask_count
         FROM asks
        GROUP BY content
        ORDER BY COALESCE(
                   MAX(created_at) FILTER (WHERE gap IS NULL OR gap > INTERVAL '10 seconds'),
                   MAX(created_at)
                 ) DESC
        LIMIT $3`,
      [user.id, MIN_PROMPT_CHARS, limit],
    );

    const prompts: HistoryRow[] = r.rows.map((row) => {
      const content = String(row.content || "");
      return {
        content:
          content.length > PREVIEW_CHARS
            ? content.slice(0, PREVIEW_CHARS) + "…"
            : content,
        last_asked_at: new Date(row.last_asked_at).toISOString(),
        ask_count: Number(row.ask_count) || 1,
      };
    });

    /* Client-side analytics fires from AssistantHistoryOverlay
     * (`assistant.history_opened` + `assistant.history_picked`).
     * That covers the learning-loop signal without bloating the
     * server-side InstinctEventType union. */
    return NextResponse.json({ prompts });
  } catch (err) {
    /* Table missing in shadow / preview, or transient DB blip. The
     * overlay degrades to an empty state — never a blocker. */
    console.warn(
      "[api/assistant/prompt-history] query failed:",
      (err as Error).message,
    );
    return NextResponse.json({ prompts: [] });
  }
}
