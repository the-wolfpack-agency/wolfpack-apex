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
import { checkDocQuality, trackGateResult, type GateResult } from "@/lib/doc-quality-gate";

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
    const { message, conversationId, pageContext, attachments, fileContents } = body as {
      message?: string;
      conversationId?: string;
      pageContext?: string;
      attachments?: { name: string; type: string; size: number }[];
      fileContents?: { name: string; content: string }[];
    };

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    // Run quality gate on file contents and track all attachments
    const gateResults: { name: string; gate: GateResult }[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        trackEvent("assistant.file_attached", user.id, user.role, {
          file_name: att.name,
          file_type: att.type,
          file_size: att.size,
          module: "assistant",
        });
      }
    }

    if (fileContents && fileContents.length > 0) {
      for (const fc of fileContents) {
        const gate = checkDocQuality(fc.content);
        trackGateResult(gate, user.id, user.role, fc.name);
        gateResults.push({ name: fc.name, gate });

        if (gate.verdict === "pass") {
          trackEvent("assistant.doc_ingested", user.id, user.role, {
            file_name: fc.name,
            verdict: "pass",
            module: "assistant",
          });
        }
      }
    }

    // If any file was rejected, return gate results without processing
    const rejected = gateResults.filter((r) => r.gate.verdict === "reject");
    if (rejected.length > 0) {
      return NextResponse.json({
        response: null,
        source: "quality_gate",
        tokensUsed: 0,
        conversationId: conversationId || null,
        gateResults: gateResults.map((r) => ({
          name: r.name,
          verdict: r.gate.verdict,
          flags: r.gate.flags,
        })),
      });
    }

    const result = await chat(message, user.id, user.role, conversationId, pageContext);

    // Include gate results (warnings) alongside the response
    const response: Record<string, unknown> = { ...result };
    if (gateResults.length > 0) {
      response.gateResults = gateResults.map((r) => ({
        name: r.name,
        verdict: r.gate.verdict,
        flags: r.gate.flags,
      }));
    }

    return NextResponse.json(response);
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
