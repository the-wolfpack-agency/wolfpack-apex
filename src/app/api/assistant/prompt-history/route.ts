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
      `SELECT
         BTRIM(m.content) AS content,
         MAX(m.created_at) AS last_asked_at,
         COUNT(*)::int AS ask_count
       FROM instinct_messages m
       JOIN instinct_conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1
         AND m.role = 'user'
         AND LENGTH(BTRIM(m.content)) >= $2
       GROUP BY BTRIM(m.content)
       ORDER BY MAX(m.created_at) DESC
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
