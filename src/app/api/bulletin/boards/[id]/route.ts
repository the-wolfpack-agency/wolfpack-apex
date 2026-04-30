/**
 * /api/bulletin/boards/[id] — single board: GET / PATCH / DELETE.
 *
 * GET returns `{ board, notes, snapshots }` so the board page can do
 * one fetch (board + active notes + snapshot index) instead of N+2.
 *
 * Notes payload is capped at 1000 (mirrors `listNotes` clamp). When
 * the cap is hit, callers should switch to the paginated `/notes`
 * endpoint we'll add when a real board ever crosses the threshold.
 *
 * DELETE is a soft-archive — sets `archived_at = NOW()`. The board
 * remains queryable (a frozen meeting artifact); writes against it
 * are blocked at the lib layer (`assertBoardWritable`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  archiveBoard,
  getBoard,
  updateBoard,
} from "@/lib/bulletin/boards";
import { listNotes } from "@/lib/bulletin/notes";
import { listSnapshots } from "@/lib/bulletin/snapshots";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  const board = await getBoard(id);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [notes, snapshots] = await Promise.all([
    listNotes(id),
    listSnapshots(id),
  ]);

  return NextResponse.json({ board, notes, snapshots });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  let body: { title?: string; description?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Parameters<typeof updateBoard>[1] = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "patch is empty" }, { status: 400 });
  }

  try {
    const board = await updateBoard(id, patch);
    if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ board });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/non-empty/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[api/bulletin/boards/id] update failed:", msg);
    return NextResponse.json({ error: "Failed to update board" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;

  /* 404 on unknown id so the UI can render a "deleted by someone else"
     state instead of a silent "ok". */
  const existing = await getBoard(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    await archiveBoard(id);
    trackEvent("bulletin.board_archived", user.id, user.role, {
      board_id: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(
      "[api/bulletin/boards/id] archive failed:",
      (err as Error).message,
    );
    return NextResponse.json({ error: "Failed to archive board" }, { status: 500 });
  }
}
