/**
 * Apex Assistant — Smart AI chat with strict priority chain.
 *
 * Priority:
 *   1. Search knowledge base (zero tokens)
 *   2. Search codebase (zero tokens)
 *   3. Check analytics data (zero tokens)
 *   4. Call AI only as last resort
 *
 * Every interaction is tracked for the learning loop.
 * AI responses are cached in apex_knowledge for future zero-token retrieval.
 */

import { searchKnowledge, saveAnswer } from "@/lib/knowledge";
import { searchCodebase, type SearchResult } from "@/lib/codebase-connector";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantSource =
  | "knowledge_cache"
  | "codebase"
  | "analytics"
  | "ai"
  | "fallback";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  source?: AssistantSource;
  tokensUsed: number;
  timestamp: string;
  rating?: number;
}

export interface AssistantResponse {
  response: string;
  source: AssistantSource;
  tokensUsed: number;
  conversationId: string;
}

// ---------------------------------------------------------------------------
// Conversation store (in-memory)
// ---------------------------------------------------------------------------

const conversations = new Map<string, AssistantMessage[]>();

function generateId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function chat(
  message: string,
  userId: string,
  userRole: string,
  conversationId?: string,
): Promise<AssistantResponse> {
  const convId = conversationId || generateId();
  if (!conversations.has(convId)) {
    conversations.set(convId, []);
  }

  const history = conversations.get(convId)!;

  // Record user message
  history.push({
    role: "user",
    content: message,
    tokensUsed: 0,
    timestamp: new Date().toISOString(),
  });

  // Track every question
  trackEvent("knowledge.question_asked", userId, userRole, {
    question_length: message.length,
    conversation_id: convId,
    module: "assistant",
  });

  // --- Priority 1: Knowledge base ---
  const knowledgeResult = await tryKnowledgeBase(message);
  if (knowledgeResult) {
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "knowledge_cache",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "knowledge_cache_hit",
      module: "assistant",
    });

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: knowledgeResult,
      source: "knowledge_cache",
      tokensUsed: 0,
      timestamp: new Date().toISOString(),
    };
    history.push(assistantMsg);

    return {
      response: knowledgeResult,
      source: "knowledge_cache",
      tokensUsed: 0,
      conversationId: convId,
    };
  }

  // --- Priority 2: Codebase search ---
  const codebaseResult = await tryCodebaseSearch(message, userId, userRole);
  if (codebaseResult) {
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "codebase",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "codebase_hit",
      module: "assistant",
    });

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: codebaseResult,
      source: "codebase",
      tokensUsed: 0,
      timestamp: new Date().toISOString(),
    };
    history.push(assistantMsg);

    return {
      response: codebaseResult,
      source: "codebase",
      tokensUsed: 0,
      conversationId: convId,
    };
  }

  // --- Priority 3: Analytics data ---
  const analyticsResult = await tryAnalyticsQuery(message, userId, userRole);
  if (analyticsResult) {
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "analytics",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "analytics_hit",
      module: "assistant",
    });

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: analyticsResult,
      source: "analytics",
      tokensUsed: 0,
      timestamp: new Date().toISOString(),
    };
    history.push(assistantMsg);

    return {
      response: analyticsResult,
      source: "analytics",
      tokensUsed: 0,
      conversationId: convId,
    };
  }

  // --- Priority 4: AI call ---
  trackEvent("knowledge.answer_not_found", userId, userRole, {
    question_length: message.length,
    module: "assistant",
  });

  const aiResult = await callAI(message, history, userId, userRole);
  if (aiResult) {
    trackEvent("system.ai_call_made", userId, userRole, {
      module: "assistant",
      tokens_used: aiResult.tokensUsed,
    });

    // Cache AI response for future zero-token retrieval
    saveAnswer(
      message,
      aiResult.content,
      "ai",
      userId,
      undefined,
      undefined,
      aiResult.tokensUsed,
    ).catch(() => {});

    const assistantMsg: AssistantMessage = {
      role: "assistant",
      content: aiResult.content,
      source: "ai",
      tokensUsed: aiResult.tokensUsed,
      timestamp: new Date().toISOString(),
    };
    history.push(assistantMsg);

    return {
      response: aiResult.content,
      source: "ai",
      tokensUsed: aiResult.tokensUsed,
      conversationId: convId,
    };
  }

  // --- Fallback ---
  const fallbackMsg = "I could not find an answer to that question. Try rephrasing or ask a more specific question about the codebase, features, or platform.";

  const assistantMsg: AssistantMessage = {
    role: "assistant",
    content: fallbackMsg,
    source: "fallback",
    tokensUsed: 0,
    timestamp: new Date().toISOString(),
  };
  history.push(assistantMsg);

  return {
    response: fallbackMsg,
    source: "fallback",
    tokensUsed: 0,
    conversationId: convId,
  };
}

// ---------------------------------------------------------------------------
// getConversationHistory
// ---------------------------------------------------------------------------

export function getConversationHistory(conversationId: string): AssistantMessage[] {
  return conversations.get(conversationId) || [];
}

// ---------------------------------------------------------------------------
// rateResponse
// ---------------------------------------------------------------------------

export function rateResponse(
  conversationId: string,
  messageIndex: number,
  rating: number,
  userId: string = "system",
  userRole: string = "dev",
): boolean {
  const history = conversations.get(conversationId);
  if (!history || messageIndex < 0 || messageIndex >= history.length) {
    return false;
  }

  const msg = history[messageIndex];
  if (msg.role !== "assistant") return false;

  msg.rating = rating;

  trackEvent("knowledge.answer_rated", userId, userRole, {
    conversation_id: conversationId,
    message_index: messageIndex,
    rating,
    source: msg.source || "unknown",
    module: "assistant",
  });

  return true;
}

// ---------------------------------------------------------------------------
// Priority 1: Knowledge base search
// ---------------------------------------------------------------------------

async function tryKnowledgeBase(message: string): Promise<string | null> {
  try {
    const results = await searchKnowledge(message, 1);
    if (results.length > 0 && results[0].rating !== null && results[0].rating >= 3) {
      return results[0].answer;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority 2: Codebase search
// ---------------------------------------------------------------------------

const CODE_KEYWORDS = [
  "function", "file", "route", "api", "component", "import", "export",
  "code", "module", "class", "interface", "type", "migration", "test",
  "endpoint", "handler", "middleware", "hook", "page", "layout",
  "src/", ".ts", ".tsx", ".js", "how does", "where is", "what does",
];

async function tryCodebaseSearch(
  message: string,
  userId: string,
  userRole: string,
): Promise<string | null> {
  const msgLower = message.toLowerCase();
  const isCodeQuestion = CODE_KEYWORDS.some((kw) => msgLower.includes(kw));
  if (!isCodeQuestion) return null;

  try {
    // Extract a search term from the question
    const searchTerm = extractSearchTerm(message);
    if (!searchTerm) return null;

    const repoPath = process.env.WOLFPACK_AUTO_REPO || "";
    if (!repoPath) return null;

    const results: SearchResult[] = searchCodebase(repoPath, searchTerm, userId, userRole);
    if (results.length === 0) return null;

    // Format results into a readable answer
    const top = results.slice(0, 5);
    const lines = top.map(
      (r) => `- **${r.file}** (line ${r.line}): \`${r.content.trim()}\``,
    );

    return `Found ${results.length} result(s) in the codebase for "${searchTerm}":\n\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

function extractSearchTerm(message: string): string {
  // Remove common question words and extract the core search term
  const cleaned = message
    .replace(/\b(where|what|how|does|is|the|a|an|in|for|to|do|can|you|find|show|me|tell|about)\b/gi, "")
    .replace(/[?!.]/g, "")
    .trim();

  // Take the longest remaining word group
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return "";
  return words.slice(0, 3).join(" ");
}

// ---------------------------------------------------------------------------
// Priority 3: Analytics query
// ---------------------------------------------------------------------------

const ANALYTICS_KEYWORDS = [
  "how many", "count", "total", "average", "events", "usage",
  "analytics", "stats", "statistics", "popular", "most used",
  "last week", "today", "yesterday", "trending", "activity",
];

async function tryAnalyticsQuery(
  message: string,
  userId: string,
  userRole: string,
): Promise<string | null> {
  const msgLower = message.toLowerCase();
  const isAnalyticsQuestion = ANALYTICS_KEYWORDS.some((kw) => msgLower.includes(kw));
  if (!isAnalyticsQuestion) return null;

  try {
    const result = await safeQuery<{ event_type: string; count: number }>(
      `SELECT event_type, COUNT(*)::int AS count
       FROM apex_events
       WHERE timestamp > NOW() - INTERVAL '7 days'
       GROUP BY event_type
       ORDER BY count DESC
       LIMIT 10`,
    );

    if (result.fromCache || result.rows.length === 0) return null;

    trackEvent("system.analytics_queried", userId, userRole, {
      module: "assistant",
      result_count: result.rows.length,
    });

    const lines = result.rows.map(
      (r) => `- **${r.event_type}**: ${r.count} event(s)`,
    );

    return `Here are the top events from the last 7 days:\n\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority 4: AI call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an assistant for Wolfpack Agency. You have deep knowledge of the wolfpack-auto dealer platform (Next.js 15, PostgreSQL, 215+ API routes, 55 migrations, 110+ tables). Answer questions directly and specifically. Never use em dashes. Use plain, professional language.`;

async function callAI(
  message: string,
  history: AssistantMessage[],
  userId: string,
  userRole: string,
): Promise<{ content: string; tokensUsed: number } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

    // Build conversation messages for context
    const messages = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10) // Last 10 messages for context
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const start = Date.now();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.content?.[0]?.text || "";
    const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    trackEvent("client.doc_generated", userId, userRole, {
      source: "assistant",
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
      model,
      module: "assistant",
    });

    return { content, tokensUsed };
  } catch {
    return null;
  }
}
