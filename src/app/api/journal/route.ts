import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getOrCreateJournal, updateJournal } from "@/lib/journal";
import { safeQuery } from "@/lib/db";

/**
 * GET /api/journal — Get today's journal for the authenticated user.
 *
 * Automatically populates from apex_events for the user's day.
 * Query params:
 *   ?date=YYYY-MM-DD — specific date (defaults to today)
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") || undefined;

  try {
    const journal = await getOrCreateJournal(user.id, date);

    // Auto-populate events from apex_events for this user + date
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const { rows: eventRows, fromCache } = await safeQuery<{
      id: string;
      event_type: string;
      user_id: string;
      metadata: Record<string, unknown>;
      timestamp: string;
    }>(
      `SELECT id::text, event_type, user_id, metadata, timestamp
       FROM apex_events
       WHERE user_id = $1
         AND timestamp::date = $2::date
       ORDER BY timestamp ASC`,
      [user.id, targetDate],
    );

    // Merge auto events into the journal auto_context
    const autoEvents = fromCache
      ? (journal.auto_context?.events as unknown[]) || []
      : eventRows.map((ev) => ({
          event_type: ev.event_type,
          timestamp: ev.timestamp,
          metadata: ev.metadata,
        }));

    const mergedJournal = {
      ...journal,
      auto_context: {
        ...journal.auto_context,
        events: autoEvents,
      },
    };

    return NextResponse.json({ journal: mergedJournal });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to get journal", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/journal — Update today's journal.
 *
 * Body: { journal_id: string, content?: string, mood?: string, highlights?: string[], blockers?: string[] }
 */
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { journal_id, content, mood, highlights, blockers } = body as {
      journal_id?: string;
      content?: string;
      mood?: string;
      highlights?: string[];
      blockers?: string[];
    };

    if (!journal_id) {
      return NextResponse.json({ error: "journal_id is required" }, { status: 400 });
    }

    const updated = await updateJournal(journal_id, user.id, {
      content,
      mood,
      highlights,
      blockers,
    });

    if (!updated) {
      return NextResponse.json({ error: "Journal not found or no updates provided" }, { status: 404 });
    }

    return NextResponse.json({ journal: updated });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to update journal", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
