/**
 * GET /api/teams/chats — list caller's cached Teams chats.
 *
 * Cache-backed read path; never hits Graph directly. Cursor-paginated.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listCachedChats } from "@/lib/integrations/microsoft-teams-chat";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const { chats, nextCursor } = await listCachedChats(user.id, {
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    cursor: cursor || undefined,
  });

  return NextResponse.json({ chats, nextCursor });
}
