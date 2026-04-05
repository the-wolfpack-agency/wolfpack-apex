import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { chat, getConversationHistory, rateResponse } from "@/lib/assistant";

/**
 * POST /api/assistant — Send a message, get a response.
 *
 * Body: { message: string, conversationId?: string }
 * Optional: { action: "rate", conversationId: string, messageIndex: number, rating: number }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    // Handle rating action
    if (body.action === "rate") {
      const { conversationId, messageIndex, rating } = body as {
        conversationId: string;
        messageIndex: number;
        rating: number;
      };

      if (!conversationId || messageIndex == null || !rating) {
        return NextResponse.json(
          { error: "conversationId, messageIndex, and rating are required" },
          { status: 400 },
        );
      }

      const ok = rateResponse(conversationId, messageIndex, rating, user.id, user.role);
      return NextResponse.json({ success: ok });
    }

    // Handle chat message
    const { message, conversationId } = body as {
      message?: string;
      conversationId?: string;
    };

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const result = await chat(message, user.id, user.role, conversationId);

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to process message", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * GET /api/assistant?conversationId=xxx — Get conversation history.
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");

  trackEvent("system.page_viewed", user.id, user.role, {
    page: "assistant",
    module: "assistant",
  });

  if (conversationId) {
    const history = getConversationHistory(conversationId);
    return NextResponse.json({ conversationId, messages: history });
  }

  return NextResponse.json({ conversationId: null, messages: [] });
}
