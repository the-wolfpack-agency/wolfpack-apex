import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  chat,
  getConversations,
  getConversationMessages,
  rateMessage,
  archiveConversation,
} from "@/lib/assistant";

/**
 * POST /api/assistant -- Send a message, rate, or archive.
 *
 * Body variants:
 *   { message: string, conversationId?: string, pageContext?: string }
 *   { action: "rate", messageId: string, rating: number }
 *   { action: "archive", conversationId: string }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    // --- Rate action ---
    if (body.action === "rate") {
      const { messageId, rating } = body as {
        messageId: string;
        rating: number;
      };

      if (!messageId || !rating) {
        return NextResponse.json(
          { error: "messageId and rating are required" },
          { status: 400 },
        );
      }

      const ok = await rateMessage(messageId, rating, user.id, user.role);
      return NextResponse.json({ success: ok });
    }

    // --- Archive action ---
    if (body.action === "archive") {
      const { conversationId } = body as { conversationId: string };

      if (!conversationId) {
        return NextResponse.json(
          { error: "conversationId is required" },
          { status: 400 },
        );
      }

      const ok = await archiveConversation(conversationId, user.id);
      return NextResponse.json({ success: ok });
    }

    // --- Chat message ---
    const { message, conversationId, pageContext } = body as {
      message?: string;
      conversationId?: string;
      pageContext?: string;
    };

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const result = await chat(message, user.id, user.role, conversationId, pageContext);

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to process message", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * GET /api/assistant
 *   ?conversations=true         -- List user's conversations
 *   ?conversationId=xxx         -- Load messages for a conversation
 *   (no params)                 -- Track page view
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);

  // List conversations
  if (url.searchParams.get("conversations") === "true") {
    const convs = await getConversations(user.id);
    return NextResponse.json({ conversations: convs });
  }

  // Load conversation messages
  const conversationId = url.searchParams.get("conversationId");
  if (conversationId) {
    const messages = await getConversationMessages(conversationId, user.id);
    return NextResponse.json({ conversationId, messages });
  }

  // Default: track page view
  trackEvent("system.page_viewed", user.id, user.role, {
    page: "assistant",
    module: "assistant",
  });

  return NextResponse.json({ conversationId: null, messages: [] });
}
