/**
 * GET /api/ms/chats/[id] — fetch messages for a single Teams chat.
 *
 * Membership gate: we fetch the chat metadata first and verify the
 * caller's MS userEmail (or userId) is in the `members` list before
 * releasing the message bodies. Chat.Read is scoped per-user in Graph
 * — but treat it as defense in depth: if Graph ever broadens the
 * returned set, we still refuse to leak chats the caller is not in.
 *
 * Responses:
 *   200 { messages: ChatMessage[] }               — success
 *   200 { messages: [], scope_missing: true }     — user needs Chat.Read consent
 *   200 { messages: [], connected: false }        — user has not linked MS
 *   401 { error: "Unauthorized" }                 — no Instinct JWT
 *   403 { error: "Not a member of this chat" }    — caller not in members
 *   404 { error: "Chat not found" }               — Graph returned 404
 *   500 { error: "Internal error" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { getChat, getChatMessagesResult } from "@/lib/ms-graph-chats";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Invalid chat id" }, { status: 400 });
    }

    const url = new URL(req.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 30)) : 30;

    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ messages: [], connected: false });
    }

    // Step 1 — fetch chat meta and verify membership.
    const meta = await getChat(token.accessToken, id, user.id);
    if (!meta.ok) {
      if (meta.code === "scope_missing") {
        return NextResponse.json({ messages: [], scope_missing: true });
      }
      if (meta.code === "not_found") {
        return NextResponse.json({ error: "Chat not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const callerEmail = (token.userEmail || user.email || "").toLowerCase();
    const isMember = meta.chat.members.some((m) => {
      return (m.email || "").toLowerCase() === callerEmail && callerEmail.length > 0;
    });
    if (!isMember) {
      return NextResponse.json(
        { error: "Not a member of this chat" },
        { status: 403 },
      );
    }

    // Step 2 — fetch messages.
    const result = await getChatMessagesResult(token.accessToken, id, limit, user.id);
    if (!result.ok) {
      return NextResponse.json({ messages: [], scope_missing: true });
    }
    return NextResponse.json({ messages: result.messages });
  } catch (err) {
    console.error("[api/ms/chats/[id]] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
