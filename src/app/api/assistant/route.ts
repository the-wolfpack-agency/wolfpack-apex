import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  chat,
  getConversations,
  getConversationMessages,
  rateMessage,
  archiveConversation,
  persistToolAnswer,
} from "@/lib/assistant";
import { checkDocQuality, trackGateResult, type GateResult } from "@/lib/doc-quality-gate";
import { tryToolAnswer, classifyIntent } from "@/lib/assistant/orchestrator";
import {
  detectRelatedPagesFromExchange,
  sourceLabelForIntent,
  type RelatedPage,
} from "@/lib/assistant/related-pages";
import { readVercelGeo } from "@/lib/assistant/vercel-geo";
import { detectUnreachable } from "@/lib/assistant/not-connected";
import { detectSocial, socialAnswer } from "@/lib/assistant/social";
import {
  isFollowThrough,
  lastAssistantMessage,
  resolveFollowThrough,
  somethingIsAlreadyWaiting,
} from "@/lib/assistant/follow-through";
import { buildAttachmentContext } from "@/lib/assistant/attachment-context";

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
    const { message: rawMessage, conversationId, pageContext, attachments, fileContents, timeZone } = body as {
      message?: string;
      conversationId?: string;
      pageContext?: string;
      attachments?: { name: string; type: string; size: number }[];
      fileContents?: { name: string; content: string }[];
      timeZone?: string;
    };

    if (!rawMessage || typeof rawMessage !== "string") {
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

    /* Read whatever the user attached to THIS message.
     *
     * `fileContents` has always arrived here complete with the image's base64
     * and was used for exactly two things: the quality gate above and an
     * analytics event. Nothing ever passed it to the model, which is why the
     * assistant answered "I cannot view screenshots or attachments directly"
     * while `ocrImage()` had been reading screenshots for brain ingest all
     * along. Images go through that same Azure call; text is used directly. */
    const attachmentContext = await buildAttachmentContext(fileContents, {
      userId: user.id,
      userRole: user.role,
    });
    const hasAttachment = attachmentContext.block.length > 0;

    // Token-free fast path: try the deterministic tool router before
    // burning any AI tokens on RAG / LLM generation.
    /* A TURN THAT REFERS TO THE PREVIOUS ONE IS RESOLVED AGAINST IT.
     *
     * "ok, do that" carries no subject. Dispatched as a fresh question it
     * matched nothing, fell through to document retrieval, and came back
     * with a chunk of an unrelated spreadsheet presented as the answer.
     * Measured on production 2026-08-23, turn three of four.
     *
     * Resolving it here, before intent classification, is deliberate:
     * every path below this point assumes the message has a subject, and
     * none of them can fail honestly when it does not. */
    let message: string = rawMessage;
    if (
      !hasAttachment &&
      isFollowThrough(rawMessage) &&
      /* Step aside when something downstream is already waiting for this
         word. A write tool asking before it acts, a routine stopped at a
         person, a template offering to be adopted: all three end by
         telling somebody to say yes, and a second reader of "yes" that
         cannot see the first one's offers will eventually contradict it.
         It did, on the template flow, in production. */
      !(await somethingIsAlreadyWaiting(user.id, conversationId))
    ) {
      const previous = await lastAssistantMessage(conversationId);
      const resolved = resolveFollowThrough(previous);
      trackEvent("assistant.follow_through_resolved", user.id, user.role, {
        resolved: resolved.rewritten ? "ran_offer" : "asked",
      });
      if (resolved.clarify) {
        const persisted = await persistToolAnswer({
          userId: user.id,
          conversationId,
          userMessage: rawMessage,
          assistantAnswer: resolved.clarify,
          source: "tool",
        });
        return NextResponse.json({
          response: resolved.clarify,
          answer: resolved.clarify,
          source: "tool",
          tokensUsed: 0,
          conversationId: persisted?.conversationId ?? conversationId ?? null,
          messageId: persisted?.messageId,
          sources: [],
          relatedPages: [],
        });
      }
      if (resolved.rewritten) message = resolved.rewritten;
    }

    /* HELLO IS NOT A SEARCH.
     *
     * A greeting carries no question, so every layer below this one
     * treats it as one. Retrieval given "hi" does not fail: it returns
     * the least-far document, which on 2026-08-24 was a spreadsheet of
     * chatbot rules, and for "I am new here" was somebody's tax form.
     *
     * Answered here, above intent classification, for the same reason
     * follow-through is: everything downstream assumes a subject, and a
     * turn without one cannot fail honestly anywhere below. */
    if (!hasAttachment) {
      const social = detectSocial(message);
      if (social) {
        const answer = socialAnswer(social, user.name?.split(" ")[0]);
        trackEvent("assistant.social_turn", user.id, user.role, { kind: social });
        const persisted = await persistToolAnswer({
          userId: user.id,
          conversationId,
          userMessage: message,
          assistantAnswer: answer,
          source: "tool",
        });
        return NextResponse.json({
          response: answer,
          answer,
          source: "tool",
          tokensUsed: 0,
          conversationId: persisted?.conversationId ?? conversationId ?? null,
          messageId: persisted?.messageId,
          sources: [],
          relatedPages: [],
        });
      }
    }

    const intentMatch = classifyIntent(message);
    trackEvent("assistant.intent_classified", user.id, user.role, {
      intent: intentMatch.intent,
      confidence: intentMatch.confidence,
    });
    /* An attachment means the question is about the file, so the deterministic
       router must not answer it. Screenshot 3 of the bug report is this exact
       failure: "we need to add a show password, so people can see the match"
       came back as "Found 22 contacts in the CRM". */
    if (intentMatch.intent !== "unknown" && !hasAttachment) {
      const toolAnswer = await tryToolAnswer(message, {
        // MS token lookup keys on connected_by = Instinct user id, NOT email.
        // Passing email here made getValidToken return null → empty calendar
        // → "you look free today" even when the user has meetings.
        userId: user.id,
        userRole: user.role,
        userDisplayName: user.name,
        timeZone,
      });
      if (toolAnswer) {
        trackEvent("assistant.tool_invoked", user.id, user.role, {
          intent: toolAnswer.intent,
        });
        // Align with the RAG path shape (`response` + `tokensUsed`) so
        // InstinctChat renders the answer text. Previously we returned
        // `answer` which the UI silently dropped.
        const toolSourceLabel = sourceLabelForIntent(toolAnswer.intent);
        const toolRelated = detectRelatedPagesFromExchange(message, toolAnswer.answer);
        // Append a trailing "See more: [Page](/route)" line so the
        // markdown renderer produces a clickable link inline, not just
        // as a floating chip row. Resilient to screens where the chip
        // row is scrolled off. Only append when we have a primary
        // related page AND the answer doesn't already name it with an
        // embedded link (don't double-link).
        const primary = toolRelated[0];
        const alreadyLinked = primary
          ? toolAnswer.answer.includes(`(${primary.href})`)
          : true;
        const answerWithLink =
          primary && !alreadyLinked
            ? `${toolAnswer.answer}\n\nSee more: [${primary.label}](${primary.href})`
            : toolAnswer.answer;
        /* Persist the user+assistant exchange so the conversation list
           in the sidebar refreshes its last_message_at and stays in
           newest-first order. Without this, every calendar/mail/goals
           query was silently dropped from persistence — active convos
           sank below stale ones. */
        const persisted = await persistToolAnswer({
          userId: user.id,
          conversationId,
          userMessage: message,
          assistantAnswer: answerWithLink,
          source: "tool",
        });
        return NextResponse.json({
          response: answerWithLink,
          answer: answerWithLink,
          source: "tool",
          intent: toolAnswer.intent,
          data: toolAnswer.data,
          tokensUsed: 0,
          conversationId: persisted?.conversationId ?? conversationId ?? null,
          messageId: persisted?.messageId,
          sources: [
            {
              id: `tool:${toolAnswer.intent}`,
              title: toolSourceLabel,
              url: toolRelated[0]?.href ?? "/",
              type: "tool",
            },
          ],
          relatedPages: toolRelated,
        });
      }
      // Tool returned null — record the fallback so the learning loop
      // can see which intents frequently miss their tool path.
      trackEvent("assistant.fallback_to_rag", user.id, user.role, {
        intent: intentMatch.intent,
      });
    }

    /* BEFORE THE MODEL: say what we cannot reach.
     *
     * A question about warranty claims or repair orders reaches no tool,
     * so it goes to a model, which answers fluently about records it has
     * never seen in a tone indistinguishable from the answers backed by
     * the client's own data. That costs tokens AND teaches somebody to
     * trust a sentence nothing checked.
     *
     * Deterministic, zero tokens, same answer every time, and it names
     * what to connect. Narrow by construction: lookups only, advice and
     * drafting fall straight through to the model where they belong. */
    if (!hasAttachment) {
      const unreachable = detectUnreachable(message);
      if (unreachable) {
        trackEvent("assistant.answered_not_connected", user.id, user.role, {
          domain: unreachable.label,
        });
        const persisted = await persistToolAnswer({
          userId: user.id,
          conversationId,
          userMessage: message,
          assistantAnswer: unreachable.answer,
          source: "tool",
        });
        return NextResponse.json({
          response: unreachable.answer,
          answer: unreachable.answer,
          source: "tool",
          tokensUsed: 0,
          conversationId: persisted?.conversationId ?? conversationId ?? null,
          messageId: persisted?.messageId,
          sources: [],
          relatedPages: [],
        });
      }
    }

    /* Vercel injects x-vercel-ip-city / -country / -latitude /
       -longitude on every request automatically (no project config
       required). Lift them off the request headers and thread through
       to chat() → dispatcher → tools so a bare prompt like "weather"
       lands on the user's actual location instead of a hard-coded
       default. Empty object on local dev / non-Vercel deployments;
       tools degrade gracefully when fields are absent. */
    const geo = readVercelGeo(req.headers);
    const result = await chat(
      message,
      user.id,
      user.role,
      conversationId,
      pageContext,
      user.workspaceId,
      geo,
      attachmentContext.block || undefined,
    );

    // Include gate results (warnings) alongside the response
    const response: Record<string, unknown> = { ...result };
    /* Explicit pass-through for connectorSource (chat UI renders the
       styled vendor badge from this). Belt-and-suspenders alongside
       the spread above — if a future refactor changes `result`'s
       shape, this line catches the regression at the API boundary
       rather than at the user-visible UI. */
    if (typeof result?.connectorSource === "string" && result.connectorSource) {
      response.connectorSource = result.connectorSource;
    }
    /* Same belt-and-suspenders for chat-action forms — required so
     * the UI can render the inline form. */
    if (result?.form && typeof result.form === "object") {
      response.form = result.form;
    }
    /* Widgets ride the same explicit pass-through pattern. */
    if (result?.widget && typeof result.widget === "object") {
      response.widget = result.widget;
    }
    /* workflowId — per-turn correlation id from chat(). Client
     * forwards it on widget + form interaction events so the funnel
     * reconstructs end-to-end. */
    if (typeof result?.workflowId === "string") {
      response.workflowId = result.workflowId;
    }
    if (gateResults.length > 0) {
      response.gateResults = gateResults.map((r) => ({
        name: r.name,
        verdict: r.gate.verdict,
        flags: r.gate.flags,
      }));
    }

    // Related-page chips are zero-token keyword matches run over BOTH
    // the user's question AND the assistant's response — the response
    // is the richer signal because it often literally names the page
    // the user should navigate to (e.g. "go to Settings"), even when
    // the question didn't. The union + dedupe is handled in
    // detectRelatedPagesFromExchange.
    let responseText = typeof result?.response === "string" ? result.response : "";
    const relatedPages: RelatedPage[] = detectRelatedPagesFromExchange(
      message,
      responseText,
    );
    if (relatedPages.length > 0) {
      response.relatedPages = relatedPages;
    }

    // If the answer names a page by word ("go to Settings") but has
    // no embedded markdown link the renderer can make clickable,
    // append "Go to: [Page](/route)" so the user gets a one-click
    // path. The chip row is a nice secondary cue; the inline link is
    // what actually closes the loop. Skip when an embedded link is
    // already present (page-facts path embeds its own link).
    const hasMarkdownLink = /\(\/[a-z][a-z0-9/-]*\)/i.test(responseText);
    if (!hasMarkdownLink && relatedPages.length > 0) {
      const primary = relatedPages[0];
      const amended = `${responseText}\n\nGo to: [${primary.label}](${primary.href})`;
      responseText = amended;
      response.response = amended;
      if (typeof response.answer === "string") {
        response.answer = amended;
      }
    }

    // If the answer contains embedded markdown links like "(/goals)" but
    // chat() didn't attach any sources (page-facts + zero-token paths),
    // synthesize source rows from the detected relatedPages. That way
    // the UI's Sources block always renders a citation for an answer
    // that told the user "go to X" — even when no RAG/KB row was cited.
    const hasMarkdownLinkNow = /\(\/[a-z][a-z0-9/-]*\)/i.test(responseText);
    const existingSources = Array.isArray(response.sources)
      ? (response.sources as unknown[])
      : [];
    if (hasMarkdownLinkNow && existingSources.length === 0 && relatedPages.length > 0) {
      response.sources = relatedPages.map((p) => ({
        id: `page:${p.domain}`,
        title: p.label,
        url: p.href,
        type: "page",
      }));
    }

    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
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
