/**
 * GET /api/teams/chats/[id]/messages — list cached messages for a chat.
 *
 * Query params: cursor, limit, search (FTS on body).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCachedChatById,
  listCachedMessages,
} from "@/lib/integrations/microsoft-teams-chat";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const chat = await getCachedChatById(user.id, id);
  if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });

  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const search = url.searchParams.get("search");

  const { messages, nextCursor } = await listCachedMessages(user.id, id, {
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    cursor: cursor || undefined,
    search: search || undefined,
  });

  return NextResponse.json({ chat, messages, nextCursor });
}
