import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getOrCreateJournal, updateJournal } from "@/lib/journal";

/**
 * GET /api/journal — Get today's journal for the authenticated user.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const journal = await getOrCreateJournal(user.id);
    return NextResponse.json({ journal });
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
