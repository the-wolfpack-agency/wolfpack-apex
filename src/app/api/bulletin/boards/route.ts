/**
 * /api/bulletin/boards — list and create bulletin boards.
 *
 * GET  → newest-first list; `?includeArchived=true` to include frozen boards.
 * POST → create + analytics emit.
 *
 * Boards are org-shared; we never scope reads by user. `owner_user_id`
 * on the resulting row is for audit / "Created by" UI badges only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createBoard, listBoards } from "@/lib/bulletin/boards";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const boards = await listBoards({
    includeArchived,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json({ boards });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { title?: string; description?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  try {
    const board = await createBoard({
      title: body.title,
      description: body.description ?? null,
      userId: user.id,
      userRole: user.role,
    });

    trackEvent("bulletin.board_created", user.id, user.role, {
      board_id: board.id,
      has_description: Boolean(board.description),
    });

    return NextResponse.json({ board });
  } catch (err) {
    console.error("[api/bulletin/boards] create failed:", (err as Error).message);
    return NextResponse.json({ error: "Failed to create board" }, { status: 500 });
  }
}
