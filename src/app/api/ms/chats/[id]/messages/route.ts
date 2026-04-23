/**
 * POST /api/ms/chats/[id]/messages — inline-compose send/reply.
 *
 * Server-side proxy in front of Graph `/me/chats/{id}/messages`. The UI
 * NEVER talks to Graph directly; all requests flow through Instinct
 * auth + the write-flag gate + the chat membership check + audit log.
 *
 * Responses:
 *   200 { message: ChatMessage }                          — success
 *   200 { scope_missing: true }                           — Graph 401/403
 *   200 { messages: [], connected: false } (no MS token)  — user hasn't linked MS
 *   400 { error: "Missing content" | "Content too long" } — body validation
 *   401 { error: "Unauthorized" }                         — no Instinct JWT
 *   403 { write_disabled: true }                          — env flag off
 *   403 { error: "Not a member of this chat" }            — caller not in members
 *   404 { error: "Chat not found" }                       — Graph returned 404
 *   500 { error: "Internal error" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { getChat, sendChatMessage } from "@/lib/ms-graph-chats";
import { isTeamsWriteEnabled } from "@/lib/instinct-flags";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";

// Graph's documented max chatMessage body is 28 KB of markup. We cap
// server-side at the same limit (character-count proxy — not a precise
// byte count, but safely below the real limit for any ASCII+BMP content).
const MAX_CONTENT_LENGTH = 28 * 1024;

interface PostBody {
  content?: unknown;
  contentType?: unknown;
}

export async function POST(
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

    // Write gate — compliance-light client deployments disable this.
    if (!isTeamsWriteEnabled()) {
      trackEvent("ms_chats.write_disabled", user.id, user.role || "user", {
        user_id: user.id,
      });
      return NextResponse.json({ write_disabled: true }, { status: 403 });
    }

    let parsed: PostBody;
    try {
      parsed = (await req.json()) as PostBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const rawContent = typeof parsed.content === "string" ? parsed.content : "";
    const trimmed = rawContent.trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ error: "Missing content" }, { status: 400 });
    }
    if (rawContent.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: "Content too long" }, { status: 400 });
    }

    const contentType: "text" | "html" =
      parsed.contentType === "html" ? "html" : "text";

    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ messages: [], connected: false });
    }

    // Step 1 — membership gate (reuse the same pattern as GET).
    const meta = await getChat(token.accessToken, id, user.id);
    if (!meta.ok) {
      if (meta.code === "scope_missing") {
        return NextResponse.json({ scope_missing: true });
      }
      if (meta.code === "not_found") {
        return NextResponse.json({ error: "Chat not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const callerEmail = (token.userEmail || user.email || "").toLowerCase();
    const isMember = meta.chat.members.some(
      (m) => (m.email || "").toLowerCase() === callerEmail && callerEmail.length > 0,
    );
    if (!isMember) {
      return NextResponse.json(
        { error: "Not a member of this chat" },
        { status: 403 },
      );
    }

    // Step 2 — send.
    const result = await sendChatMessage(
      token.accessToken,
      id,
      rawContent,
      contentType,
      user.id,
    );

    if (!result.ok) {
      if (result.code === "scope_missing") {
        return NextResponse.json({ scope_missing: true });
      }
      return NextResponse.json(
        { error: "Send failed" },
        { status: 502 },
      );
    }

    // Step 3 — audit.
    const reqMeta = extractRequestMetadata(req);
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role || "user" },
        action: "ms_chats.message_sent",
        resourceType: "ms_chat_message",
        resourceId: result.message.id,
        afterState: {
          chat_id: id,
          message_id: result.message.id,
          content_type: result.message.body.contentType,
          length: result.message.body.content.length,
        },
        ...reqMeta,
      });
    } catch (auditErr) {
      console.warn(
        "[api/ms/chats/[id]/messages] audit write failed:",
        (auditErr as Error).message,
      );
    }

    return NextResponse.json({ message: result.message });
  } catch (err) {
    console.error(
      "[api/ms/chats/[id]/messages] error:",
      (err as Error).message,
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
