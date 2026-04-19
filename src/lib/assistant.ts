/**
 * Wolfpack Assistant -- Smart AI chat with persistent memory and strict priority chain.
 *
 * Priority:
 *   1. Search knowledge base (zero tokens)
 *   2. Check analytics data (zero tokens)
 *   3. Call AI only as last resort
 *
 * Conversations, messages, and user memory are persisted to PostgreSQL.
 * AI responses are cached in apex_knowledge for future zero-token retrieval.
 */

import { searchKnowledge, saveAnswer } from "@/lib/knowledge";
import { queryBrain, markCited as markBrainCited } from "@/lib/brain/query";
import { neutralizeInjection } from "@/lib/brain/security";
import { searchMeetingTranscripts } from "@/lib/plaud";

import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantSource =
  | "knowledge_cache"
  | "analytics"
  | "meeting_transcripts"
  | "brain"
  | "ai"
  | "fallback";

export interface AssistantMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  source?: AssistantSource;
  tokensUsed: number;
  timestamp: string;
  rating?: number;
  metadata?: Record<string, unknown>;
}

export interface AssistantResponse {
  response: string;
  source: AssistantSource;
  tokensUsed: number;
  conversationId: string;
  messageId?: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  status: string;
  messageCount: number;
  totalTokens: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface UserMemoryEntry {
  id: string;
  memoryType: string;
  key: string;
  value: string;
  confidence: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STALE_CONVERSATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CONTEXT_MESSAGES = 20;

const TOPIC_KEYWORDS: Record<string, string[]> = {
  inventory: ["inventory", "stock", "vin", "vehicle", "car", "listing"],
  leads: ["lead", "leads", "prospect", "customer", "crm"],
  pricing: ["price", "pricing", "cost", "margin", "markup", "discount"],
  analytics: ["analytics", "metric", "report", "dashboard", "data", "chart"],
  security: ["security", "auth", "login", "password", "permission", "role"],
  compliance: ["compliance", "regulation", "gdpr", "audit", "policy"],
  onboarding: ["onboarding", "setup", "getting started", "configure", "install"],
  payments: ["payment", "billing", "invoice", "charge", "subscription"],
  fi: ["f&i", "finance", "insurance", "warranty", "deal"],
  integrations: ["api", "webhook", "integration", "connect", "sync"],
};

// ---------------------------------------------------------------------------
// ID generation (no crypto dependency needed)
// ---------------------------------------------------------------------------

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function dbCreateConversation(
  userId: string,
  title?: string,
): Promise<string> {
  const id = generateId();
  await safeQuery(
    `INSERT INTO apex_conversations (id, user_id, title, status, message_count, total_tokens, last_message_at, created_at)
     VALUES ($1, $2, $3, 'active', 0, 0, NOW(), NOW())`,
    [id, userId, title || null],
  );
  return id;
}

async function dbSaveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  source: AssistantSource | null,
  tokensUsed: number,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const id = generateId();
  await safeQuery(
    `INSERT INTO apex_messages (id, conversation_id, role, content, source, tokens_used, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [id, conversationId, role, content, source, tokensUsed, JSON.stringify(metadata)],
  );
  return id;
}

async function dbUpdateConversationStats(
  conversationId: string,
  tokensUsed: number,
): Promise<void> {
  await safeQuery(
    `UPDATE apex_conversations
     SET message_count = message_count + 1,
         total_tokens = total_tokens + $2,
         last_message_at = NOW()
     WHERE id = $1`,
    [conversationId, tokensUsed],
  );
}

async function dbSetConversationTitle(
  conversationId: string,
  title: string,
): Promise<void> {
  await safeQuery(
    `UPDATE apex_conversations SET title = $2 WHERE id = $1 AND title IS NULL`,
    [conversationId, title],
  );
}

async function dbGetRecentActiveConversation(
  userId: string,
): Promise<{ id: string; last_message_at: string } | null> {
  const result = await safeQuery<{ id: string; last_message_at: string }>(
    `SELECT id, last_message_at FROM apex_conversations
     WHERE user_id = $1 AND status = 'active'
     ORDER BY last_message_at DESC NULLS LAST
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function dbGetConversationMessages(
  conversationId: string,
  limit: number = MAX_CONTEXT_MESSAGES,
): Promise<AssistantMessage[]> {
  const result = await safeQuery<{
    id: string;
    role: "user" | "assistant";
    content: string;
    source: AssistantSource | null;
    tokens_used: number;
    rating: number | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, role, content, source, tokens_used, rating, metadata, created_at
     FROM apex_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  return result.rows.reverse().map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    source: r.source || undefined,
    tokensUsed: r.tokens_used,
    timestamp: r.created_at,
    rating: r.rating ?? undefined,
    metadata: r.metadata,
  }));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function chat(
  message: string,
  userId: string,
  userRole: string,
  conversationId?: string,
  pageContext?: string,
): Promise<AssistantResponse> {
  // --- Resolve or create conversation ---
  let convId = conversationId || null;

  if (!convId) {
    // Check for recent active conversation to auto-resume
    const recent = await dbGetRecentActiveConversation(userId);
    if (recent && recent.last_message_at) {
      const age = Date.now() - new Date(recent.last_message_at).getTime();
      if (age < STALE_CONVERSATION_MS) {
        convId = recent.id;
      }
    }
  }

  if (!convId) {
    convId = await dbCreateConversation(userId);
  }

  // --- Load context ---
  const [history, userMemory] = await Promise.all([
    dbGetConversationMessages(convId, MAX_CONTEXT_MESSAGES),
    getUserMemory(userId),
  ]);

  // --- Detect topics and store ---
  const topics = autoDetectTopics(message);
  const msgMetadata: Record<string, unknown> = {};
  if (topics.length > 0) {
    msgMetadata.topic = topics[0];
    msgMetadata.topics = topics;
    // Store topics in user memory
    for (const topic of topics) {
      setUserMemory(userId, "topic", topic, "asked about " + topic).catch(() => {});
    }
  }
  if (pageContext) {
    msgMetadata.pageContext = pageContext;
  }

  // --- Save user message ---
  await dbSaveMessage(convId, "user", message, null, 0, msgMetadata);
  await dbUpdateConversationStats(convId, 0);

  // --- Auto-generate title from first message ---
  if (history.length === 0) {
    const title = message.length > 60 ? message.slice(0, 57) + "..." : message;
    dbSetConversationTitle(convId, title).catch(() => {});
  }

  // Track every question
  trackEvent("knowledge.question_asked", userId, userRole, {
    question_length: message.length,
    conversation_id: convId,
    module: "assistant",
    topics: topics.join(","),
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

    const msgId = await dbSaveMessage(convId, "assistant", knowledgeResult, "knowledge_cache", 0);
    await dbUpdateConversationStats(convId, 0);

    return {
      response: knowledgeResult,
      source: "knowledge_cache",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 2: Analytics data ---
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

    const msgId = await dbSaveMessage(convId, "assistant", analyticsResult, "analytics", 0);
    await dbUpdateConversationStats(convId, 0);

    return {
      response: analyticsResult,
      source: "analytics",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 3: Meeting transcripts (zero-token, from Plaud ingestion) ---
  const meetingResult = await tryMeetingTranscripts(message);
  if (meetingResult) {
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "meeting_transcripts",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "meeting_transcripts_hit",
      module: "assistant",
    });

    const msgId = await dbSaveMessage(convId, "assistant", meetingResult, "meeting_transcripts", 0);
    await dbUpdateConversationStats(convId, 0);

    return {
      response: meetingResult,
      source: "meeting_transcripts",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 4: Central Brain (RAG over user-uploaded docs) ---
  // Fires before AI fallback so the assistant grounds answers in real
  // company docs when it can. If the top hit is strong enough
  // (score >= 0.5 OR keyword+semantic match), we return a citation-
  // linked answer at zero model tokens. Otherwise we pass the hits as
  // context to the AI call below via pageContext.
  const brainResult = await tryBrain(message, userId, userRole, convId);
  if (brainResult) {
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "brain",
      tokens_used: brainResult.tokensUsed,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "brain_hit",
      module: "assistant",
    });
    await markBrainCited(brainResult.queryLogId, userId, userRole);

    const msgId = await dbSaveMessage(convId, "assistant", brainResult.answer, "brain", brainResult.tokensUsed);
    await dbUpdateConversationStats(convId, brainResult.tokensUsed);

    return {
      response: brainResult.answer,
      source: "brain",
      tokensUsed: brainResult.tokensUsed,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 5: AI call ---
  trackEvent("knowledge.answer_not_found", userId, userRole, {
    question_length: message.length,
    module: "assistant",
  });

  const aiResult = await callAI(message, history, userMemory, userId, userRole, pageContext);
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

    const msgId = await dbSaveMessage(convId, "assistant", aiResult.content, "ai", aiResult.tokensUsed);
    await dbUpdateConversationStats(convId, aiResult.tokensUsed);

    return {
      response: aiResult.content,
      source: "ai",
      tokensUsed: aiResult.tokensUsed,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Fallback ---
  const fallbackMsg =
    "I don't have information on that yet. You can help me learn by adding it to the Knowledge Base, or try asking about:\n\n" +
    "- Our platforms (Instinct, Auto, Learn)\n" +
    "- Team members and roles\n" +
    "- Tech stack and infrastructure\n" +
    "- Costs and pricing\n" +
    "- Features and capabilities\n\n" +
    "The more the team adds to the knowledge base, the more I can answer without AI.";

  const msgId = await dbSaveMessage(convId, "assistant", fallbackMsg, "fallback", 0);
  await dbUpdateConversationStats(convId, 0);

  return {
    response: fallbackMsg,
    source: "fallback",
    tokensUsed: 0,
    conversationId: convId,
    messageId: msgId,
  };
}

// ---------------------------------------------------------------------------
// getConversations -- List all conversations for a user
// ---------------------------------------------------------------------------

export async function getConversations(userId: string): Promise<ConversationSummary[]> {
  const result = await safeQuery<{
    id: string;
    title: string | null;
    status: string;
    message_count: number;
    total_tokens: number;
    last_message_at: string | null;
    created_at: string;
  }>(
    `SELECT id, title, status, message_count, total_tokens, last_message_at, created_at
     FROM apex_conversations
     WHERE user_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [userId],
  );

  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    messageCount: r.message_count,
    totalTokens: r.total_tokens,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// getConversationMessages -- Load full message history (verify ownership)
// ---------------------------------------------------------------------------

export async function getConversationMessages(
  conversationId: string,
  userId: string,
): Promise<AssistantMessage[]> {
  // Verify ownership
  const convResult = await safeQuery<{ id: string }>(
    `SELECT id FROM apex_conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (convResult.rows.length === 0) return [];

  return dbGetConversationMessages(conversationId, 200);
}

// ---------------------------------------------------------------------------
// rateMessage -- Update rating in apex_messages
// ---------------------------------------------------------------------------

export async function rateMessage(
  messageId: string,
  rating: number,
  userId: string,
  userRole: string = "dev",
): Promise<boolean> {
  if (rating < 1 || rating > 5) return false;

  const result = await safeQuery<{ id: string; source: string }>(
    `UPDATE apex_messages SET rating = $2
     WHERE id = $1
     AND conversation_id IN (SELECT id FROM apex_conversations WHERE user_id = $3)
     RETURNING id, source`,
    [messageId, rating, userId],
  );

  if (result.rows.length === 0) return false;

  trackEvent("knowledge.answer_rated", userId, userRole, {
    message_id: messageId,
    rating,
    source: result.rows[0].source || "unknown",
    module: "assistant",
  });

  return true;
}

// ---------------------------------------------------------------------------
// archiveConversation -- Mark as archived, generate summary
// ---------------------------------------------------------------------------

export async function archiveConversation(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  // Load messages to generate summary
  const messages = await getConversationMessages(conversationId, userId);
  if (messages.length === 0) return false;

  const summary = generateConversationSummary(messages);

  const result = await safeQuery<{ id: string }>(
    `UPDATE apex_conversations
     SET status = 'archived', summary = $2
     WHERE id = $1 AND user_id = $3
     RETURNING id`,
    [conversationId, summary, userId],
  );

  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// User Memory
// ---------------------------------------------------------------------------

export async function getUserMemory(userId: string): Promise<UserMemoryEntry[]> {
  const result = await safeQuery<{
    id: string;
    memory_type: string;
    key: string;
    value: string;
    confidence: number;
    source: string;
  }>(
    `SELECT id, memory_type, key, value, confidence, source
     FROM apex_user_memory
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId],
  );

  return result.rows.map((r) => ({
    id: r.id,
    memoryType: r.memory_type,
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    source: r.source,
  }));
}

export async function setUserMemory(
  userId: string,
  memoryType: string,
  key: string,
  value: string,
  source: string = "auto",
): Promise<void> {
  await safeQuery(
    `INSERT INTO apex_user_memory (id, user_id, memory_type, key, value, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id, memory_type, key) DO UPDATE
     SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = NOW()`,
    [generateId(), userId, memoryType, key, value, source],
  );
}

// ---------------------------------------------------------------------------
// Topic auto-detection
// ---------------------------------------------------------------------------

export function autoDetectTopics(message: string): string[] {
  const lower = message.toLowerCase();
  const detected: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      detected.push(topic);
    }
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Conversation summary generation (zero-token)
// ---------------------------------------------------------------------------

export function generateConversationSummary(messages: AssistantMessage[]): string {
  const questions = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);

  const answers = messages
    .filter((m) => m.role === "assistant" && m.source !== "fallback")
    .map((m) => {
      const preview = m.content.length > 100 ? m.content.slice(0, 97) + "..." : m.content;
      return `[${m.source || "unknown"}] ${preview}`;
    });

  const parts: string[] = [];

  if (questions.length > 0) {
    const topQuestions = questions.slice(0, 5);
    parts.push("Questions: " + topQuestions.join("; "));
  }

  if (answers.length > 0) {
    const topAnswers = answers.slice(0, 3);
    parts.push("Key answers: " + topAnswers.join("; "));
  }

  const totalTokens = messages.reduce((sum, m) => sum + m.tokensUsed, 0);
  parts.push(`${messages.length} messages, ${totalTokens} tokens used.`);

  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Legacy compat: getConversationHistory (for existing route tests)
// ---------------------------------------------------------------------------

export async function getConversationHistory(
  conversationId: string,
  userId?: string,
): Promise<AssistantMessage[]> {
  if (userId) {
    return getConversationMessages(conversationId, userId);
  }
  // Fallback: load without ownership check (for backward compat)
  return dbGetConversationMessages(conversationId, 200);
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
// Priority 2: Analytics query
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
// Priority 3: Meeting transcripts (zero-token search over Plaud ingestion)
// ---------------------------------------------------------------------------

const MEETING_KEYWORDS = [
  "meeting", "call", "discussed", "talked about", "said", "agreed",
  "decided", "action item", "follow up", "follow-up", "huddle",
  "standup", "review", "sync", "1:1", "1on1", "client call", "kickoff",
];

function looksLikeMeetingQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  return MEETING_KEYWORDS.some((kw) => lower.includes(kw));
}

async function tryMeetingTranscripts(message: string): Promise<string | null> {
  // Cheap gate first — only search transcripts if the question
  // looks like it's about a meeting / discussion / decision.
  if (!looksLikeMeetingQuestion(message)) return null;

  try {
    const matches = await searchMeetingTranscripts(message, 3);
    if (matches.length === 0 || matches[0].score === 0) return null;

    const fmtDate = (d: string | null) => {
      if (!d) return "unknown date";
      try {
        return new Date(d).toLocaleDateString("en-US", {
          month: "short", day: "numeric", year: "numeric",
        });
      } catch { return d; }
    };

    const lines: string[] = ["Here is what I found in recent meeting transcripts:"];
    for (const m of matches) {
      const title = m.title || "Untitled meeting";
      const owner = m.ownerName ? ` (${m.ownerName})` : "";
      const when = fmtDate(m.recordedAt || m.ingestedAt);
      lines.push("");
      lines.push(`**${title}**${owner} — ${when}`);
      if (m.summary) lines.push(m.summary);
      lines.push(`> ${m.snippet}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority 4: Central Brain (user-ingested docs)
// ---------------------------------------------------------------------------

interface BrainHitAnswer {
  answer: string;
  tokensUsed: number;
  queryLogId: number;
}

/**
 * Query the Brain's keyword+semantic retrieval. Returns a formatted
 * answer ONLY when at least one hit crosses the confidence threshold
 * (semantic or keyword+semantic hit, OR pure keyword with score >= 0.05).
 * Otherwise returns null so the chain falls through to the AI call.
 *
 * The returned string is already formatted with markdown citations so
 * the chat UI can render source links without extra wiring.
 */
async function tryBrain(
  message: string,
  userId: string,
  userRole: string,
  conversationId: string,
): Promise<BrainHitAnswer | null> {
  try {
    const result = await queryBrain({
      userId,
      userRole,
      query: message,
      limit: 5,
      conversationId,
    });
    if (result.hits.length === 0) return null;

    // Gate: require either a semantic-blended hit OR a keyword hit with
    // reasonable tsrank score. ts_rank_cd returns values typically in
    // [0, 1]; 0.05 is a conservative floor that filters out barely-
    // tangential chunks without missing real signal.
    const strong = result.hits.filter((h) => {
      if (h.source.includes("semantic")) return true;
      return h.score >= 0.05;
    });
    if (strong.length === 0) return null;

    // Format zero-LLM-token response. Each chunk is passed through
    // neutralizeInjection() so a hostile document containing
    // "Ignore previous instructions" can't influence a future LLM turn
    // that includes this message in its history. Matched patterns are
    // replaced with [filtered:<label>] tags so the user can see what
    // was flagged and the brain_query_log row records the labels.
    const lines: string[] = [
      "Here's what the brain has on this:",
      "",
    ];
    const allMatchedLabels = new Set<string>();
    for (const h of strong.slice(0, 3)) {
      const raw = h.content.slice(0, 500).replace(/\s+/g, " ").trim();
      const { text: safe, matchedLabels } = neutralizeInjection(raw);
      for (const l of matchedLabels) allMatchedLabels.add(l);
      lines.push(
        `**${h.document_filename}** (chunk ${h.chunk_idx + 1})`,
      );
      lines.push(`> ${safe}${h.content.length > 500 ? "…" : ""}`);
      lines.push("");
    }
    const sourcesLine =
      `*Sources: ${strong.length} brain chunk${strong.length === 1 ? "" : "s"}, ` +
      `${result.keyword_hits} keyword · ${result.semantic_hits} semantic · ` +
      `${result.latency_ms}ms` +
      (allMatchedLabels.size > 0 ? ` · filtered: ${[...allMatchedLabels].join(",")}` : "") +
      "*";
    lines.push(sourcesLine);
    return {
      answer: lines.join("\n"),
      tokensUsed: result.tokens_used,
      queryLogId: result.query_log_id,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority 5: AI call
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  userRole: string,
  userMemory: UserMemoryEntry[],
  conversationSummary?: string,
): string {
  const parts: string[] = [
    "You are the Wolfpack Assistant. You have deep knowledge of the wolfpack-auto dealer platform (Next.js 15, PostgreSQL, 215+ API routes, 55 migrations, 110+ tables). Answer questions directly and specifically. Never use em dashes. Use plain, professional language.",
  ];

  parts.push(`The user's role is: ${userRole}.`);

  const expertise = userMemory.filter((m) => m.memoryType === "expertise" || m.memoryType === "topic");
  if (expertise.length > 0) {
    const areas = expertise.map((m) => m.key).slice(0, 10).join(", ");
    parts.push(`The user has previously asked about: ${areas}.`);
  }

  const preferences = userMemory.filter((m) => m.memoryType === "preference");
  if (preferences.length > 0) {
    const prefs = preferences.map((m) => `${m.key}: ${m.value}`).slice(0, 5).join("; ");
    parts.push(`User preferences: ${prefs}.`);
  }

  if (conversationSummary) {
    parts.push(`Previous conversation context: ${conversationSummary}`);
  }

  return parts.join("\n\n");
}

async function callAI(
  message: string,
  history: AssistantMessage[],
  userMemory: UserMemoryEntry[],
  userId: string,
  userRole: string,
  pageContext?: string,
): Promise<{ content: string; tokensUsed: number } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
    const systemPrompt = buildSystemPrompt(userRole, userMemory);

    // Build conversation messages for context
    const messages = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Add current message with page context if provided
    const currentContent = pageContext
      ? `[Context: ${pageContext}]\n\n${message}`
      : message;

    messages.push({ role: "user", content: currentContent });

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
        system: systemPrompt,
        messages,
      }),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.content?.[0]?.text || "";
    const tokensUsed =
      (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

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
