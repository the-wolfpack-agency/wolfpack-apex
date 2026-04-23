/**
 * GET /api/ms/chats — list recent Teams chats for the signed-in user.
 *
 * Server-side proxy: UI calls this so we don't leak the MS token to
 * the browser. Auth via the Instinct JWT (`getUserFromRequest`). The
 * MS token is resolved server-side via `getValidToken(user.id)`.
 *
 * Responses:
 *   200 { chats: Chat[], self_email: string }  — success. self_email is
 *       the caller's Microsoft identity (from instinct_ms_tokens),
 *       NOT their Instinct session email — those can differ. The UI
 *       needs the MS email to correctly identify "the other member"
 *       in each 1:1 chat.
 *   200 { chats: [], scope_missing: true }     — user needs to grant Chat.Read
 *   200 { chats: [], connected: false }        — user has not linked MS yet
 *   401 { error: "Unauthorized" }              — no Instinct JWT
 *   500 { error: "Internal error" }            — unexpected failure
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { listChatsResult } from "@/lib/ms-graph-chats";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 25)) : 25;

    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ chats: [], connected: false });
    }

    const result = await listChatsResult(token.accessToken, limit, user.id);
    if (!result.ok) {
      return NextResponse.json({ chats: [], scope_missing: true });
    }
    return NextResponse.json({ chats: result.chats, self_email: token.userEmail });
  } catch (err) {
    console.error("[api/ms/chats] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
