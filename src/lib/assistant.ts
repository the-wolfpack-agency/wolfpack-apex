/**
 * Wolfpack Assistant -- Smart AI chat with persistent memory and strict priority chain.
 *
 * Priority:
 *   1. Search knowledge base (zero tokens)
 *   2. Check analytics data (zero tokens)
 *   3. Call AI only as last resort
 *
 * Conversations, messages, and user memory are persisted to PostgreSQL.
 * AI responses are cached in instinct_knowledge for future zero-token retrieval.
 */

import { searchKnowledge, saveAnswer } from "@/lib/knowledge";
import { queryBrain, markCited as markBrainCited } from "@/lib/brain/query";
import { neutralizeInjection } from "@/lib/brain/security";
import { getCitationRefs } from "@/lib/brain/repo";
import { searchMeetingTranscripts } from "@/lib/plaud";

import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";
import { matchPageFacts } from "@/lib/assistant/page-facts-matcher";
import { formatPageFactsAnswer } from "@/lib/assistant/page-facts";
import { getRelevantContext } from "@/lib/assistant/context-resolver";
import {
  captureFactFromCorrection,
  findRelevantFacts,
  renderFactsBlock,
} from "@/lib/assistant/learning";
import {
  getAssistantStrictness,
  getKnownTeamNames,
  lowConfidenceMessage,
  runAnswerQualityChecks,
  validateCitations,
} from "@/lib/assistant/answer-quality";
import { welcomePromptTextsForRole } from "@/lib/assistant/welcome-prompts";
import {
  tryDispatchTool,
  savePendingAction,
  consumeMostRecentPendingAction,
  detectConfirmationIntent,
  persistTeamFact,
  getToolByName,
} from "@/lib/assistant/tools";
import { getAIClient, NoProviderAvailableError } from "@/lib/ai";
import { selectAssistantTier, parseTierDirective, type TierDirective } from "@/lib/assistant/model-tier";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantSource =
  | "page_facts"
  | "knowledge_cache"
  | "user_qa_cache"
  | "analytics"
  | "meeting_transcripts"
  | "brain"
  | "tool"
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

export interface AssistantSourceRef {
  /** Stable identifier for the underlying record (knowledge row id, brain
   *  chunk id, transcript id, …). Never a free-text blob. */
  id: string;
  /** Human-readable title — rendered on the chip. */
  title: string;
  /** Best-effort absolute route users can click to see the source. */
  url: string;
  /** Categorical bucket: "knowledge" | "brain" | "meeting" | "analytics" | "ai_cache". */
  type: string;
}

export interface AssistantResponse {
  response: string;
  source: AssistantSource;
  tokensUsed: number;
  conversationId: string;
  messageId?: string;
  /** Source attributions surfaced to the UI. Empty array when the answer
   *  is generic (fallback / pure AI / etc.). */
  sources?: AssistantSourceRef[];
  /** Connector name when the answer was served by a CRM/external-system
   *  tool (salesforce, hubspot, github, jira, …). The UI renders this
   *  as a styled badge alongside the existing source-class badge so
   *  the user can tell which system the data came from. Undefined for
   *  non-connector answers (page-facts / brain / pure AI / etc.). */
  connectorSource?: string;
  /** Structured form spec when the answer included a chat-action form
   *  (create email / message / calendar event / task). The UI renders
   *  it inline below the answer text. Typed as `unknown` here to keep
   *  the assistant.ts module free of a forms/ runtime dependency —
   *  the chat UI imports the strict FormSpec type from
   *  @/lib/assistant/forms/types. */
  form?: unknown;
  /** Interactive widget spec (calendar grid, email thread, task list,
   *  …) when the tool returned one. Same `unknown` rationale as
   *  `form`; the chat UI imports the strict WidgetSpec type from
   *  @/lib/assistant/widgets/types. */
  widget?: unknown;
  /** Stable id for this assistant turn — same UUID is included in
   *  every analytics event fired during the turn so funnels can be
   *  reconstructed post-hoc (intent → tool → widget render →
   *  widget click → form submit). The chat UI may forward it on
   *  follow-up POSTs (analytics events, form submits) to extend the
   *  funnel client-side. */
  workflowId?: string;
  /** Role-tailored starter prompts surfaced inline when the assistant
   *  returns a low-confidence / fallback response. Always exactly 3
   *  strings when present. ONLY attached on fallback branches (bare
   *  fallback + AI low-confidence reject) — the chat UI uses the
   *  field's presence as the gate to render clickable chips. Absent
   *  on successful tool / knowledge / RAG / brain hits so we don't
   *  clutter a confident answer with "try one of these instead"
   *  affordances. Source of truth: welcomePromptTextsForRole(). */
  fallbackChips?: string[];
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

// ---------------------------------------------------------------------------
// Knowledge-cache bypass for meeting / date-bound queries.
//
// The existing `instinct_knowledge` cache is keyed on a coarse text-match
// over the question. That was acceptable for "what is our pricing model"
// style questions, but it broke badly on date-bound questions: asking
// "which meetings did wolfpack have on April 20" matched a cached
// "wolfpack team members" answer (loose token overlap on "wolfpack")
// and returned stale, wrong content with a "Zero tokens" badge.
//
// Rule: when the question contains explicit date / meeting / temporal
// markers, NEVER serve from the existing knowledge cache — these
// queries need fresh data from SharePoint + Project + meetings.
//
// The list is the codified version of the user's invariant: "tooling
// first." Adding a new pattern means appending to this array. No
// per-call hand-tuning.
// ---------------------------------------------------------------------------

export const MEETING_OR_DATE_BYPASS_PATTERNS: RegExp[] = [
  /\bmeeting(s)?\b/i,
  /\bdiscussed?\b/i,
  /\bagenda\b/i,
  /\btranscript\b/i,
  /\bcall(s)? (with|on|about)\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/i,
  /\b(yesterday|today|tomorrow|this week|last week|next week)\b/i,
  /* Weekday names — "Calendar Monday" / "schedule Tuesday" / "what
     meetings do I have on Friday" all signal a date-bound calendar
     query, not a page-description request. Without this row the
     page-facts matcher fires on the page-name keyword and returns
     "Calendar — Your Microsoft 365 calendar view…" instead of routing
     to the calendar tool. (Regression 2026-05-15.) */
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /* Document-name patterns: questions referencing a specific file by
     extension or naming pattern must skip page-facts/knowledge so the
     LLM gets the SharePoint context. The previous regression: asking
     "what's in the TWA Agenda 4.20 doc?" matched the page-facts entry
     for the Instinct Docs page on the substring "doc", returning a
     canned blurb about Instinct's Docs UI instead of grounding the
     answer in the actual SharePoint file. */
  /\.(docx?|xlsx?|pptx?|pdf|md|txt|csv)\b/i,
  /\bthe\s+\S+\s+(doc|document|report|deck|spec|spreadsheet|file|memo)\b/i,
  /\b(spreadsheet|deck|memo)\b/i,
];

/**
 * Return true when the question is meeting- or date-bound and must NOT
 * be served from the stale knowledge cache. Pure regex check — zero-cost.
 */
export function shouldBypassKnowledgeCache(question: string): boolean {
  if (!question) return false;
  return MEETING_OR_DATE_BYPASS_PATTERNS.some((p) => p.test(question));
}

// ---------------------------------------------------------------------------
// Org-wide exact-match Q/A cache.
//
// The Wolfpack Assistant is the org's shared knowledge base: a question
// answered once benefits every team member. The shared knowledge cache is
// intentionally bypassed for date-bound and document-name questions
// because loose token-overlap matching used to return stale rows
// ("wolfpack team members" for "meetings on April 20"). But a verbatim
// repeat of the same normalized question — by anyone in the org — should
// always be served from cache: the date itself is in the question, so
// the answer is deterministic. Re-burning tokens for it is indefensible.
//
// We solve this with a strict ORG-wide, exact-match-on-normalized-text
// cache backed by `instinct_messages`. Single-tenant deployment (one
// agency = one org), so any prior answer in the table is fair game. The
// originating message id is recorded in metadata so we can attribute the
// cached answer if anyone asks "where did this come from?".
//
// TTL: 7 days for date-bound queries (date in the question). 60 minutes
// for everything else (hedge against underlying-data updates landing
// during the day).
// ---------------------------------------------------------------------------

/** Normalize a question for exact-match cache hits. */
export function normalizeQuestionForCache(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:'"()]/g, "")
    .trim();
}

const ORG_QA_TTL_MS_DEFAULT = 60 * 60 * 1000;          // 1 hour
const ORG_QA_TTL_MS_DATE_BOUND = 7 * 24 * 60 * 60 * 1000; // 7 days

interface OrgQACacheHit {
  answer: string;
  source: AssistantSource;
  /** Original tokens spent on the cached answer — telemetry only;
   *  the cache hit itself costs zero. */
  originalTokens: number;
  /** Original assistant message id, for attribution. */
  originalMessageId: string;
}

/** Stop-words removed from the fuzzy-match token set. */
const STOPWORDS = new Set([
  "the","a","an","of","and","or","but","is","are","was","were","be","been",
  "do","did","does","have","has","had","this","that","these","those","i",
  "you","we","they","my","our","their","on","in","at","to","for","with",
  "about","what","which","who","whom","when","where","why","how","please",
  "tell","me","show","get","give","could","would","should","can","may",
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeQuestionForCache(text)
      .split(" ")
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const FUZZY_SIM_THRESHOLD = 0.8;

async function findOrgQACacheHit(
  message: string,
): Promise<OrgQACacheHit | null> {
  if (!process.env.DATABASE_URL) return null;
  const normalized = normalizeQuestionForCache(message);
  if (!normalized) return null;
  const ttlMs = shouldBypassKnowledgeCache(message)
    ? ORG_QA_TTL_MS_DATE_BOUND
    : ORG_QA_TTL_MS_DEFAULT;

  try {
    /* Find the most recent USER message in ANY conversation matching the
       normalized text, then return the assistant message that immediately
       follows it. Org-wide: a question answered once benefits everyone.
       We deliberately do NOT scope by user_id — single-tenant agency
       deployment, no cross-tenant concerns. The originating message id
       is captured so the cached answer is attributable. */
    const r = await safeQuery<{
      message_id: string;
      answer: string;
      source: AssistantSource | null;
      tokens_used: number;
    }>(
      `SELECT a.id AS message_id, a.content AS answer, a.source, a.tokens_used
         FROM instinct_messages u
         JOIN LATERAL (
           SELECT m2.id, m2.content, m2.source, m2.tokens_used, m2.created_at
             FROM instinct_messages m2
            WHERE m2.conversation_id = u.conversation_id
              AND m2.role = 'assistant'
              AND m2.created_at > u.created_at
            ORDER BY m2.created_at ASC
            LIMIT 1
         ) a ON TRUE
        WHERE u.role = 'user'
          AND lower(regexp_replace(regexp_replace(u.content, '[?!.,;:''"()]', '', 'g'), '\\s+', ' ', 'g')) = $1
          AND u.created_at > NOW() - ($2::bigint || ' milliseconds')::interval
          AND a.source IS DISTINCT FROM 'fallback'
          AND a.tokens_used > 0
          /* Sentinel guard: never serve a "No X / not found" empty-tool
             answer from cache. Those came from narrow tool paths that
             didn't see the full data sources. The follow-up call must
             rerun the tool (now broader) or fall through to the LLM. */
          AND a.content NOT ILIKE 'No meetings recorded%'
          AND a.content NOT ILIKE 'No meetings found%'
          AND a.content NOT ILIKE 'No results found%'
        ORDER BY u.created_at DESC
        LIMIT 1`,
      [normalized, ttlMs],
    );
    const row = r.rows[0];
    if (row) {
      return {
        answer: row.answer,
        source: (row.source ?? "ai") as AssistantSource,
        originalTokens: row.tokens_used ?? 0,
        originalMessageId: row.message_id,
      };
    }

    /* No exact match. Pull a window of recent user→assistant pairs and
       rank them by token-set Jaccard similarity to the incoming
       question. ALL answered questions become potential cache hits —
       supports paraphrases and trivial reformatting differences. */
    const fuzzy = await safeQuery<{
      message_id: string;
      question: string;
      answer: string;
      source: AssistantSource | null;
      tokens_used: number;
    }>(
      `SELECT a.id AS message_id, u.content AS question, a.content AS answer,
              a.source, a.tokens_used
         FROM instinct_messages u
         JOIN LATERAL (
           SELECT m2.id, m2.content, m2.source, m2.tokens_used, m2.created_at
             FROM instinct_messages m2
            WHERE m2.conversation_id = u.conversation_id
              AND m2.role = 'assistant'
              AND m2.created_at > u.created_at
            ORDER BY m2.created_at ASC
            LIMIT 1
         ) a ON TRUE
        WHERE u.role = 'user'
          AND u.created_at > NOW() - ($1::bigint || ' milliseconds')::interval
          AND a.source IS DISTINCT FROM 'fallback'
          AND a.tokens_used > 0
        ORDER BY u.created_at DESC
        LIMIT 200`,
      [ttlMs],
    );

    const incomingTokens = tokenSet(message);
    let best: { row: typeof fuzzy.rows[number]; score: number } | null = null;
    for (const candidate of fuzzy.rows) {
      /* Same sentinel guard as the exact-match path. */
      if (
        /^no meetings recorded/i.test(candidate.answer) ||
        /^no meetings found/i.test(candidate.answer) ||
        /^no results found/i.test(candidate.answer)
      ) {
        continue;
      }
      const score = jaccard(incomingTokens, tokenSet(candidate.question));
      if (!best || score > best.score) best = { row: candidate, score };
    }
    if (best && best.score >= FUZZY_SIM_THRESHOLD) {
      return {
        answer: best.row.answer,
        source: (best.row.source ?? "ai") as AssistantSource,
        originalTokens: best.row.tokens_used ?? 0,
        originalMessageId: best.row.message_id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

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
    `INSERT INTO instinct_conversations (id, user_id, title, status, message_count, total_tokens, last_message_at, created_at)
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
    `INSERT INTO instinct_messages (id, conversation_id, role, content, source, tokens_used, metadata, created_at)
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
    `UPDATE instinct_conversations
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
    `UPDATE instinct_conversations SET title = $2 WHERE id = $1 AND title IS NULL`,
    [conversationId, title],
  );
}

async function dbGetRecentActiveConversation(
  userId: string,
): Promise<{ id: string; last_message_at: string } | null> {
  const result = await safeQuery<{ id: string; last_message_at: string }>(
    `SELECT id, last_message_at FROM instinct_conversations
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
     FROM instinct_messages
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

/**
 * Convert [ref:<uuid>] citation markers into a numbered Sources footer
 * with clickable links (when the source document has a web_url) and
 * inline footnote markers ([1], [2], ...).
 *
 * Before:
 *   "We have the Options Awareness training [ref:abc-123] and PCBA
 *   101 [ref:def-456]."
 *
 * After:
 *   "We have the Options Awareness training [1] and PCBA 101 [2].
 *
 *   **Sources:**
 *   1. [Options Awareness training](https://...)
 *   2. [PCBA 101](https://...)"
 *
 * Best-effort: if a brain lookup fails or returns no rows, we leave
 * the raw [ref:<id>] markers in place rather than corrupting the
 * answer.
 */
async function appendSourceFooter(
  answer: string,
  keptRefs: string[],
  /* Fallback: brain hits that were prompted to the LLM but the LLM
   * didn't emit [ref:<id>] markers for (it ignored the citation
   * format instruction). When non-empty AND keptRefs is empty, we
   * append a "Sources retrieved" section so the user still sees
   * which documents the answer drew from. */
  fallbackHits: Array<{ document_id: string }> = [],
): Promise<string> {
  if (!answer) return answer;
  /* Prefer the cited refs (the LLM explicitly tied them to its
   * answer). Fall back to the prompted hits when the LLM ignored the
   * ref-marker instruction but clearly used the content. */
  const idsToLookup =
    keptRefs.length > 0 ? keptRefs : fallbackHits.map((h) => h.document_id);
  if (idsToLookup.length === 0) return answer;

  let refs;
  try {
    refs = await getCitationRefs(idsToLookup);
  } catch {
    return answer;
  }
  if (refs.length === 0) return answer;

  /* Replace [ref:<id>] markers with [N] footnotes when the LLM DID
   * emit them. When falling back from hits, there are no markers to
   * replace — the footer just appends. */
  const idToNum = new Map(refs.map((r, i) => [r.id, i + 1]));
  const replaced = answer.replace(/\s?\[ref:([A-Za-z0-9_-]+)\]/g, (_m, id) => {
    const n = idToNum.get(String(id).trim());
    return n ? ` [${n}]` : "";
  });

  const headerLabel =
    keptRefs.length > 0 ? "**Sources:**" : "**Sources retrieved:**";
  const lines: string[] = [replaced.trim(), "", headerLabel];
  refs.forEach((r, i) => {
    const num = i + 1;
    if (r.web_url) {
      lines.push(`${num}. [${r.filename}](${r.web_url})`);
    } else {
      lines.push(`${num}. ${r.filename}`);
    }
  });
  return lines.join("\n");
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
  /* Tenant the caller belongs to. Optional for backward-compat —
     callers that haven't been updated since migration 137 still pass
     5 args; falls back to "default" via the literal in the dispatcher
     call below. Once every caller is updated, this becomes required. */
  workspaceId: string = "default",
  /* Best-effort IP geolocation extracted from Vercel edge headers by
     the route handler. Threaded through to tools (currently: weather)
     so a bare prompt like "weather" lands on the user's actual city
     instead of a hard-coded default. Optional — local dev / non-
     Vercel deployments pass nothing and downstream tools degrade. */
  geo?: import("@/lib/assistant/tools/types").VercelGeo,
  /* Text read out of the file(s) attached to THIS message, already rendered as
     a prompt block by buildAttachmentContext(). When present it means the user
     is asking about something in front of them, which changes how this turn is
     routed — see the guards below. */
  attachmentBlock?: string,
): Promise<AssistantResponse> {
  /* workflow_id correlates every analytics event fired during this
   * single chat() turn (tool dispatch, page-facts hit, brain hit,
   * intent_unmatched, AI fallback, etc.). Lets the admin dashboard
   * reconstruct funnels from the event stream. UUID-ish; the
   * exact format doesn't matter as long as it's collision-resistant
   * within a turn-volume horizon. */
  const workflowId = generateId();

  // --- Resolve or create conversation ---
  // 2026-05-23: auto-resume of the most-recent active conversation was
  // removed. When the client posts without a conversationId, the server
  // used to silently attach the message to the user's most-recent
  // conversation, which caused the chat UI to jump to that old chat
  // after a Send. If a caller wants to continue an existing chat, it
  // must pass the conversationId explicitly. No conversationId = brand
  // new conversation, period.
  let convId = conversationId || null;
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

  /* Learning loop: if the new user message looks like a correction of
     the previous assistant turn, capture it as an org fact so future
     prompts across the team are grounded with it. Pure regex + SQL,
     zero LLM tokens. Best-effort — failures must not block the chat. */
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  if (lastAssistant) {
    captureFactFromCorrection({
      userMessage: message,
      priorAssistantContent: lastAssistant.content,
      priorAssistantMessageId: lastAssistant.id ?? null,
      userId,
      userRole,
    })
      .then((fact) => {
        if (fact) {
          trackEvent("assistant.org_fact_captured", userId, userRole, {
            module: "assistant",
            attribute: fact.attribute,
            subject_length: fact.subject.length,
          });
        }
      })
      .catch(() => {});
  }

  // --- Auto-generate title from first message ---
  if (history.length === 0) {
    const title = message.length > 60 ? message.slice(0, 57) + "..." : message;
    dbSetConversationTitle(convId, title).catch(() => {});
  }

  // Track every question
  trackEvent("knowledge.question_asked", userId, userRole, {
    workflow_id: workflowId,
    question_length: message.length,
    conversation_id: convId,
    module: "assistant",
    topics: topics.join(","),
  });

  /* THE DIRECTIVE IS AN INSTRUCTION TO US, NOT PART OF THE QUESTION.
     Parsed and removed here, at the top of the turn, rather than inside
     callAI. Everything below matches on the text: a leading "/cheap" made
     "/cheap what is the weather in NYC today?" miss the weather tool, whose
     pattern is anchored, and the question then fell through to a keyword
     branch. Stripping it only before the prompt would have left every
     deterministic matcher looking at a message the user did not write. */
  const tierOverride = parseTierDirective(message);
  if (tierOverride) message = tierOverride.cleaned;

  // --- Priority -3: Confirm / cancel a pending action ---
  // The user's previous turn dispatched an action tool, the dispatcher
  // returned needs_confirmation, and we persisted a pending row. If
  // this turn is a confirmation phrase (yes / confirm / proceed / etc.)
  // we execute. If it's a cancellation phrase, we drop it. Anything
  // else falls through to the rest of the priority chain.
  const confirmIntent = detectConfirmationIntent(message);
  if (confirmIntent !== "none") {
    const row = await consumeMostRecentPendingAction(userId, confirmIntent);
    if (row) {
      if (confirmIntent === "cancel") {
        trackEvent("assistant.action_cancelled", userId, userRole, {
          tool: row.tool_name,
          pending_id: row.id,
        });
        const cancelMsg = `Cancelled. Nothing was saved.`;
        const msgId = await dbSaveMessage(convId, "assistant", cancelMsg, "tool", 0);
        await dbUpdateConversationStats(convId, 0);
        return {
          response: cancelMsg,
          source: "tool",
          tokensUsed: 0,
          conversationId: convId,
          messageId: msgId,
        };
      }
      /* confirmIntent === "confirm" → execute the pending action. */
      const exec = await executePendingAction(row, userId, userRole, workspaceId);
      trackEvent("assistant.action_confirmed", userId, userRole, {
        tool: row.tool_name,
        pending_id: row.id,
      });
      const msgId = await dbSaveMessage(convId, "assistant", exec.answer, "tool", 0);
      await dbUpdateConversationStats(convId, 0);
      return {
        response: exec.answer,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
        sources: exec.sources,
      };
    }
    /* Confirmation phrase but no pending row — treat as ordinary text
       and fall through. */
  }

  // --- Priority -2: Deterministic tool dispatch ---
  // Phase 1 of the agentic-executor work. Before any cache / RAG / LLM,
  // try to match the question to a deterministic tool (see
  // src/lib/assistant/tools/). Tools answer parameterized questions
  // ("what do we know about X", "did <client> pay this month") by
  // reading from a typed data source, zero LLM tokens. If no tool's
  // intent matches, fall through to the existing priority chain.
  const toolResult = await tryDispatchTool(message, {
    userId,
    userRole,
    /* Workspace flows in from the session via the chat() arg —
       every tool that reads workspace-scoped state (connector
       credentials, brain pack, strictness) reads it from here. */
    workspaceId,
    workflowId,
    /* Vercel IP geo flows from the route handler through chat() into
       every tool dispatch. Tools (e.g. weather) use it as the
       location fallback when the user's message didn't capture a
       specific city — fixes the NYC-user-gets-Houston bug. */
    ...(geo ? { geo } : {}),
  });
  if (toolResult && toolResult.result.ok) {
    /* Extract connector attribution from the tool's typed result data
       when present (CRM/GitHub tools all put `connector` at the top
       level of their data block). The UI renders this as a styled
       badge so multi-CRM workspaces can tell which system the data
       came from. We persist it in message metadata so the badge
       survives conversation reload too. */
    const toolData = toolResult.result.data as
      | { connector?: string }
      | undefined;
    const connectorSource =
      typeof toolData?.connector === "string" && toolData.connector
        ? toolData.connector
        : undefined;
    /* Structured form (chat-action create_* tools) and widget
       (interactive surfaces like the calendar). Both persist in
       message metadata so a page refresh / conversation reload
       restores them on historical messages. */
    const formSpec = (toolResult.result as { form?: unknown }).form;
    const widgetSpec = (toolResult.result as { widget?: unknown }).widget;
    const meta: Record<string, unknown> = {};
    if (connectorSource) meta.connector_source = connectorSource;
    if (formSpec) meta.form = formSpec;
    if (widgetSpec) meta.widget = widgetSpec;
    const msgId = await dbSaveMessage(
      convId,
      "assistant",
      toolResult.result.answer,
      "tool",
      0,
      meta,
    );
    await dbUpdateConversationStats(convId, 0);
    return {
      response: toolResult.result.answer,
      source: "tool",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
      sources: toolResult.result.sources,
      workflowId,
      ...(connectorSource ? { connectorSource } : {}),
      ...(formSpec ? { form: formSpec } : {}),
      ...(widgetSpec ? { widget: widgetSpec } : {}),
    };
  }
  // Tool intent matched but execution failed (validation / capability /
  // internal) — surface a deterministic failure message rather than
  // silently falling through. The user got matched to a tool; they
  // deserve to know why it didn't run.
  if (toolResult && !toolResult.result.ok && toolResult.result.code !== "no_match") {
    /* Action-tool needs_confirmation: persist the pending action and
       return the confirm prompt. The user's next "yes" / "confirm"
       triggers Priority -3 above on the following turn. */
    if (toolResult.result.code === "needs_confirmation") {
      const tool = getToolByName(toolResult.tool);
      /* Re-run matchIntent so we have the structured params to persist.
         (The dispatcher consumed them but only used them for validation;
         we need them again for the pending row.) */
      const params = (tool?.matchIntent(message) ?? {}) as Record<string, unknown>;
      const description = toolResult.result.message.replace(/^tool \S+ /, "");
      const saved = await savePendingAction({
        userId,
        toolName: toolResult.tool,
        params: params as Record<string, unknown>,
        description,
      });
      trackEvent("assistant.action_pending", userId, userRole, {
        tool: toolResult.tool,
        pending_id: saved.id,
        description: saved.description.slice(0, 200),
      });
      const promptMsg =
        `I'll ${describePendingAction(toolResult.tool, params)}.\n\n` +
        `Say **"confirm"** to proceed, or **"cancel"** to drop it. ` +
        `(This auto-cancels in 5 minutes.)`;
      const msgId = await dbSaveMessage(convId, "assistant", promptMsg, "tool", 0);
      await dbUpdateConversationStats(convId, 0);
      return {
        response: promptMsg,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
      };
    }
    const failureMsg =
      toolResult.result.code === "capability"
        ? `That tool (${toolResult.tool}) needs a higher-privilege role than yours.`
        : `I couldn't run ${toolResult.tool}: ${toolResult.result.message.slice(0, 200)}`;
    const msgId = await dbSaveMessage(convId, "assistant", failureMsg, "tool", 0);
    await dbUpdateConversationStats(convId, 0);
    return {
      response: failureMsg,
      source: "tool",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority -1: Org-wide exact-match Q/A cache ---
  // The assistant is the organization's shared knowledge base. ANY
  // identical normalized question that has been answered before — by
  // anyone in the org, within the TTL — is served back at zero tokens.
  // This is the structural guard against "the same question costs us
  // again every time". Bypasses are inapplicable here because the
  // cached answer was generated from the same exact question (so any
  // date markers in the question already constrained the original
  // answer's freshness window).
  /* Every zero-token fast path below answers from something OTHER than the
     attachment: a cached answer to a similar question, the page-facts registry,
     the knowledge base, analytics, transcripts, the brain. All of them are
     right when the question stands alone, and all of them are wrong when the
     user has just attached a file and asked about it.
     
     This is what produced the reported behaviour. "look at the screen shot"
     with a screenshot attached was answered from three OLDER screenshots the
     brain had indexed, and a message about adding a show-password toggle came
     back as a list of 22 CRM contacts. The turn never reached the model with
     the attachment in hand, because it never reached the model at all. */
  const hasAttachment = Boolean(attachmentBlock && attachmentBlock.trim());
  if (hasAttachment) {
    trackEvent("assistant.attachment_routed_to_ai", userId, userRole, {
      module: "assistant",
      chars: attachmentBlock!.length,
    });
  }

  const orgCacheHit = hasAttachment ? null : await findOrgQACacheHit(message);
  if (orgCacheHit) {
    trackEvent("assistant.org_qa_cache_hit", userId, userRole, {
      module: "assistant",
      original_tokens_saved: orgCacheHit.originalTokens,
      original_source: orgCacheHit.source,
      original_message_id: orgCacheHit.originalMessageId,
    });
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "user_qa_cache",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "org_qa_cache_hit",
      module: "assistant",
    });
    const msgId = await dbSaveMessage(
      convId,
      "assistant",
      orgCacheHit.answer,
      "user_qa_cache",
      0,
      {
        original_source: orgCacheHit.source,
        original_message_id: orgCacheHit.originalMessageId,
      },
    );
    await dbUpdateConversationStats(convId, 0);
    return {
      response: orgCacheHit.answer,
      source: "user_qa_cache",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 0: Page facts (zero-token, static page descriptions) ---
  // Users constantly ask "what is the Calendar page?" or "how do I use
  // Goals?". Historically these fell into the Knowledge Base priority
  // and matched an unrelated entry. The page-facts registry returns a
  // rich description of the actual Instinct page — plus an embedded
  // markdown link so detectRelatedPagesFromExchange picks up the route
  // and renders the chip naturally.
  /* Page-facts is a static lookup table for "what is the Calendar page?"
     style questions. It must NEVER fire for date-bound, meeting-bound,
     or document-name queries — those need fresh LLM grounding from
     SharePoint + Project + meetings. We reuse the same bypass regex
     so the rule is codified in one place. */
  const pageFactsBypass = shouldBypassKnowledgeCache(message);
  if (pageFactsBypass) {
    trackEvent("assistant.page_facts_bypassed", userId, userRole, {
      reason: "meeting_or_date_or_document_query",
      module: "assistant",
    });
  }
  const pageFactsMatch = pageFactsBypass || hasAttachment ? null : matchPageFacts(message);
  if (pageFactsMatch && pageFactsMatch.confidence >= 0.6) {
    const answer = formatPageFactsAnswer(pageFactsMatch.page);
    trackEvent("assistant.page_facts_hit", userId, userRole, {
      module: "assistant",
      domain: pageFactsMatch.page.domain,
      confidence: pageFactsMatch.confidence,
    });
    trackEvent("knowledge.answer_found", userId, userRole, {
      source: "page_facts",
      tokens_used: 0,
      module: "assistant",
    });
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "page_facts_hit",
      module: "assistant",
    });

    const msgId = await dbSaveMessage(convId, "assistant", answer, "page_facts", 0, {
      domain: pageFactsMatch.page.domain,
      confidence: pageFactsMatch.confidence,
    });
    await dbUpdateConversationStats(convId, 0);

    return {
      response: answer,
      source: "page_facts",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority 1: Knowledge base (skipped for meeting / date-bound queries) ---
  // Date-bound or meeting-bound questions must NEVER serve from the
  // stale knowledge cache — `searchKnowledge` does loose token matching
  // and will happily return a "team members" answer for a "what
  // meetings on April 20" question. Bypass and let the LLM see fresh
  // SharePoint + Project + meeting context via getRelevantContext.
  const bypassCache = shouldBypassKnowledgeCache(message);
  if (bypassCache) {
    trackEvent("assistant.knowledge_cache_bypassed", userId, userRole, {
      reason: "meeting_or_date_query",
      module: "assistant",
    });
  }
  const knowledgeResult = bypassCache || hasAttachment ? null : await tryKnowledgeBase(message);
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

    const msgId = await dbSaveMessage(
      convId,
      "assistant",
      knowledgeResult.answer,
      "knowledge_cache",
      0,
      { source_ids: knowledgeResult.sources.map((s) => s.id) },
    );
    await dbUpdateConversationStats(convId, 0);

    return {
      response: knowledgeResult.answer,
      source: "knowledge_cache",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
      sources: knowledgeResult.sources,
    };
  }

  // --- Priority 2: Analytics data ---
  const analyticsResult = hasAttachment ? null : await tryAnalyticsQuery(message, userId, userRole);
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
  const meetingResult = hasAttachment ? null : await tryMeetingTranscripts(message);
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
  const { strong: brainResult, context: brainContext } = await tryBrain(
    message,
    userId,
    userRole,
    convId,
  );
  /* Brain CONTEXT is still gathered and passed to the model below — a
     screenshot plus company knowledge is a better answer than either alone.
     Only its zero-token short-circuit is suppressed. */
  if (brainResult && !hasAttachment) {
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
      sources: brainResult.sources,
      workflowId,
    };
  }

  // --- Priority 5: AI call ---
  trackEvent("knowledge.answer_not_found", userId, userRole, {
    question_length: message.length,
    module: "assistant",
  });

  /* Unmet-intent capture: we reached the AI fallback, which means no
   * deterministic tool matched + no page_facts hit + no brain hit.
   * Log the raw message (truncated) so the admin insights page can
   * surface a backlog of phrasings to build for. This is the
   * single highest-value signal for "what should we build next."
   * Stored separately from the other ai_call_skipped reasons because
   * those represent SUCCESS (deterministic path won) — this is the
   * miss. */
  trackEvent("assistant.intent_unmatched", userId, userRole, {
    /* Raw text capped at 500 chars so a runaway paste doesn't bloat
     * the analytics row. We log the message itself so the admin
     * page can cluster + rank by frequency. */
    message_text: message.slice(0, 500),
    message_length: message.length,
    module: "assistant",
    has_brain_context: brainContext.hits.length > 0,
    has_page_context: !!pageContext,
    workflow_id: workflowId,
  });

  const aiResult = await callAI(
    message,
    history,
    userMemory,
    userId,
    userRole,
    pageContext,
    brainContext,
    attachmentBlock,
    tierOverride,
  );
  if (aiResult) {
    trackEvent("system.ai_call_made", userId, userRole, {
      module: "assistant",
      tokens_used: aiResult.tokensUsed,
      workflow_id: workflowId,
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

    /* Answer-quality gate: validate entities + stale-doc cues + citations
       on the LLM output before it reaches the user. Reject-severity flags
       swap in the deterministic low-confidence message; warn-severity
       flags either pre-pend an in-band notice (permissive) or also
       upgrade to reject (strict, for enterprise tenants). Every flag
       fires `assistant.quality_flag_raised` so the learning loop can
       tune thresholds over time. */
    const [knownNames, strictness] = await Promise.all([
      getKnownTeamNames(),
      getAssistantStrictness(),
    ]);

    /* Citation validation: strip any [ref:X] token whose <X> isn't in the
       set of sources we actually retrieved this turn. The valid set is
       sourced from brainContext.hits (weak-but-real brain hits the LLM
       was prompted with). Any [ref:X] outside that set is a
       hallucination and gets dropped. */
    const validSourceIds = (brainContext?.hits ?? []).map((h) => h.document_id);
    const citationCheck = validateCitations(aiResult.content, validSourceIds);
    if (citationCheck.droppedRefs.length > 0) {
      trackEvent("assistant.quality_flag_raised", userId, userRole, {
        filter: "citations",
        severity: "block",
        reason: `dropped ${citationCheck.droppedRefs.length} invented citation(s): ${citationCheck.droppedRefs.slice(0, 3).join(", ")}`,
        verdict: "reject",
        strictness,
      });
    }

    const quality = runAnswerQualityChecks(
      {
        answer: citationCheck.cleanAnswer,
        knownNames,
        /* topScore + hitCount + retrievedIds now thread through from the
           brain retrieval. Confidence gate (A1) fires when no real hits
           backed the answer. Citation gate (A3) fires when factual
           claims aren't cited. */
        topScore: brainContext?.topScore,
        hitCount: brainContext?.hits.length,
        retrievedIds: validSourceIds,
      },
      { userId, userRole, strictness },
    );
    let safeContent = citationCheck.cleanAnswer;
    if (quality.verdict === "reject") {
      /* Append the "Try one of these instead:" lead-in so the inline
         chips the chat UI renders below have a visual anchor — without
         this, the chips appear orphaned underneath the prose. Keep the
         base lowConfidenceMessage() untouched (it's reused by tests +
         other call-sites). */
      safeContent = `${lowConfidenceMessage()} Try one of these instead:`;
    } else if (quality.verdict === "low_confidence") {
      const flagReasons = quality.flags.map((f) => f.reason).join("; ");
      safeContent =
        `_Note: this answer may need a second look. ${flagReasons}._\n\n` +
        citationCheck.cleanAnswer;
    }
    /* Convert [ref:<id>] markers into a numbered Sources footer with
     * clickable links to each cited document's web_url. Skipped on
     * rejected answers (the deterministic fallback message has no
     * citations to enrich). Passes the prompted brain hits as a
     * fallback so the LLM ignoring our citation-format instruction
     * still produces a useful Sources block. */
    if (quality.verdict !== "reject") {
      safeContent = await appendSourceFooter(
        safeContent,
        citationCheck.keptRefs,
        brainContext?.hits ?? [],
      );
    }

    const msgId = await dbSaveMessage(convId, "assistant", safeContent, "ai", aiResult.tokensUsed);
    await dbUpdateConversationStats(convId, aiResult.tokensUsed);

    /* AI low-confidence reject path: the quality gate forced the
       deterministic low-confidence message, so the user is effectively
       in a dead-end. Surface role-tailored starter prompts as inline
       chips and fire one analytics event so we can measure how often
       the fallback affordance gets shown (numerator for chip-CTR). */
    if (quality.verdict === "reject") {
      const fallbackChips = welcomePromptTextsForRole(userRole);
      trackEvent("assistant.fallback_chips_offered", userId, userRole, {
        role: userRole,
        chip_count: fallbackChips.length,
        source: "ai",
        module: "assistant",
        workflow_id: workflowId,
      });
      return {
        response: safeContent,
        source: "ai",
        tokensUsed: aiResult.tokensUsed,
        conversationId: convId,
        messageId: msgId,
        workflowId,
        fallbackChips,
      };
    }

    return {
      response: safeContent,
      source: "ai",
      tokensUsed: aiResult.tokensUsed,
      conversationId: convId,
      messageId: msgId,
      workflowId,
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
    "The more the team adds to the knowledge base, the more I can answer without AI. Try one of these instead:";

  const msgId = await dbSaveMessage(convId, "assistant", fallbackMsg, "fallback", 0);
  await dbUpdateConversationStats(convId, 0);

  /* Bare-fallback path (no AI provider configured / AI call returned
     null). Same chip-affordance rationale as the AI-reject branch
     above: the user otherwise gets a dead-end response. */
  const fallbackChips = welcomePromptTextsForRole(userRole);
  trackEvent("assistant.fallback_chips_offered", userId, userRole, {
    role: userRole,
    chip_count: fallbackChips.length,
    source: "fallback",
    module: "assistant",
    workflow_id: workflowId,
  });

  return {
    response: fallbackMsg,
    source: "fallback",
    tokensUsed: 0,
    conversationId: convId,
    messageId: msgId,
    workflowId,
    fallbackChips,
  };
}

// ---------------------------------------------------------------------------
// persistToolAnswer -- Save the user message + tool answer to the
// conversation, bump message_count, and refresh last_message_at.
//
// Used by the legacy intent-router fast-path in /api/assistant which
// returns BEFORE chat() runs. Without this helper, every calendar /
// mail / financial / goals query would silently skip persistence,
// leaving the sidebar's conversation list ordered by stale timestamps
// (2026-05-16 bug: active "calendar 22 messages" convos sank below
// older RAG-handled ones because their last_message_at never moved).
//
// Returns { conversationId, messageId } so the route can echo them back
// to the client (the UI needs both to render the new message + keep the
// sidebar in sync). Best-effort: failures don't throw — a missed
// persistence is bad UX, but losing the answer text would be worse.
// ---------------------------------------------------------------------------

export async function persistToolAnswer(opts: {
  userId: string;
  conversationId?: string | null;
  userMessage: string;
  assistantAnswer: string;
  /* "tool" for orchestrator answers; other AssistantSource values are
     accepted in case a caller wants finer attribution. */
  source?: AssistantSource;
  metadata?: Record<string, unknown>;
}): Promise<{ conversationId: string; messageId: string } | null> {
  try {
    // 2026-05-23: removed dbGetRecentActiveConversation auto-resume here
    // for parity with the main chat() path. Callers that want to append
    // to an existing conversation must pass conversationId explicitly.
    let convId = opts.conversationId || null;
    if (!convId) {
      convId = await dbCreateConversation(opts.userId);
    }
    await dbSaveMessage(convId, "user", opts.userMessage, null, 0);
    const msgId = await dbSaveMessage(
      convId,
      "assistant",
      opts.assistantAnswer,
      opts.source ?? "tool",
      0,
      opts.metadata ?? {},
    );
    /* Two stats bumps because dbUpdateConversationStats increments by
       exactly one per call (matches the user+assistant message pair). */
    await dbUpdateConversationStats(convId, 0);
    await dbUpdateConversationStats(convId, 0);
    return { conversationId: convId, messageId: msgId };
  } catch (err) {
    /* Persistence failure is non-fatal — the user already got the
       answer. Log so the next session can see it in the analytics
       feed; do NOT throw. */
    console.warn("[assistant] persistToolAnswer failed:", (err as Error).message);
    return null;
  }
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
     FROM instinct_conversations
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
    `SELECT id FROM instinct_conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  if (convResult.rows.length === 0) return [];

  return dbGetConversationMessages(conversationId, 200);
}

// ---------------------------------------------------------------------------
// rateMessage -- Update rating in instinct_messages
// ---------------------------------------------------------------------------

export async function rateMessage(
  messageId: string,
  rating: number,
  userId: string,
  userRole: string = "dev",
): Promise<boolean> {
  if (rating < 1 || rating > 5) return false;

  const result = await safeQuery<{ id: string; source: string }>(
    `UPDATE instinct_messages SET rating = $2
     WHERE id = $1
     AND conversation_id IN (SELECT id FROM instinct_conversations WHERE user_id = $3)
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
    `UPDATE instinct_conversations
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
     FROM instinct_user_memory
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
    `INSERT INTO instinct_user_memory (id, user_id, memory_type, key, value, source, created_at, updated_at)
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

interface KnowledgeMatch {
  answer: string;
  sources: AssistantSourceRef[];
}

/* Trigram similarity floor for "this KB entry actually answers the
   question." searchKnowledge SQL retrieves anything > 0.1, but that
   floor exists so a slightly-rephrased question still finds the
   right entry — NOT to decide whether the entry is relevant. Without
   a real quality gate here, "what is Nurburgring?" matched
   "what is Morning Briefing?" on the shared "what is" trigrams and
   served the Dashboard answer (regression reported 2026-05-14).

   0.45 is empirically the boundary where same-topic questions still
   land (e.g. "how does auth work" vs "how does the auth system work"
   sits around 0.55) but cross-topic "what is X" vs "what is Y" falls
   below (typically 0.2–0.35). */
const KB_MIN_SIMILARITY = 0.45;

async function tryKnowledgeBase(message: string): Promise<KnowledgeMatch | null> {
  try {
    const results = await searchKnowledge(message, 5);
    // Unrated entries (rating === null) are KEPT — they represent fresh
    // knowledge the team just added. Only entries explicitly graded low
    // (rating <= 2) are skipped. Walk the top matches so a slightly
    // different phrasing still lands on a good entry.
    const usable = results.filter((r) => r.rating === null || r.rating > 2);
    if (usable.length === 0) return null;
    const top = usable[0];
    /* Quality gate: only serve from KB when the top match is actually
       similar enough to be plausibly the right answer. Rows from
       shadow-mode demo data don't carry sim (KnowledgeEntry.sim is
       undefined) and bypass the gate — the demo fixture's small,
       curated set is implicitly relevant. */
    if (top.sim !== undefined && top.sim < KB_MIN_SIMILARITY) return null;
    // Surface up to 3 sources so the user can click through to the
    // underlying KB entries. Each source carries a stable id + a
    // deep link into /knowledge so the UI chip is clickable.
    const sources: AssistantSourceRef[] = usable.slice(0, 3).map((hit) => ({
      id: hit.id,
      title: hit.question,
      url: `/knowledge?entry=${encodeURIComponent(hit.id)}`,
      type: "knowledge",
    }));
    return { answer: top.answer, sources };
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
       FROM instinct_events
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
  sources: AssistantSourceRef[];
}

/**
 * Brain context surfaced to the AI fallback path even when there was
 * no STRONG hit. Carries the raw hits + top score so the LLM can be
 * grounded in weak retrievals AND the answer-quality runner has real
 * topScore + validSourceIds inputs (no more empty-set fallbacks).
 */
interface BrainContext {
  hits: Array<{
    document_id: string;
    document_filename: string;
    content: string;
    score: number;
  }>;
  topScore: number;
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
/* ------------------------------------------------------------------ */
/* Phase-3 action-tool execution                                       */
/* ------------------------------------------------------------------ */

/**
 * Execute a confirmed pending action. Dispatches on tool_name to the
 * matching action handler. Each new action tool needs a case here.
 *
 * Read-only tools never land here (they don't go through the
 * needs_confirmation flow). Only action tools that requiresConfirmation
 * = true.
 */
async function executePendingAction(
  row: import("@/lib/assistant/tools/pending-actions").PendingActionRow,
  userId: string,
  userRole: string,
  workspaceId?: string,
): Promise<{ answer: string; sources?: AssistantSourceRef[] }> {
  if (row.tool_name === "save_team_fact") {
    const p = row.params as { subject?: string; attribute?: string; value?: string };
    if (!p.subject || !p.attribute || !p.value) {
      return { answer: "The pending action's parameters were incomplete; nothing saved." };
    }
    const result = await persistTeamFact({
      userId,
      userRole,
      subject: p.subject,
      attribute: p.attribute,
      value: p.value,
    });
    if (result.ok) {
      return {
        answer: `✓ Saved: **${p.subject}** → **${p.attribute}**: ${p.value}`,
      };
    }
    return {
      answer: `I tried to save it, but the write was refused (${result.reason}). Nothing was stored.`,
    };
  }
  if (row.tool_name === "create_external_record") {
    const mod = await import("@/lib/assistant/tools/create-external-record-tool");
    const portalMod = await import("@/lib/assistant/tools/portal-link");
    const result = await mod.executeCreateExternalRecord(
      row.params as unknown as Parameters<typeof mod.executeCreateExternalRecord>[0],
      { userId, userRole, workspaceId },
    );
    if (result.ok) {
      /* Salesforce success → append a "Open in Wolfpack portal" link so
         the user lands on the new record without retyping its id. */
      const objectType =
        (row.params as { objectType?: string } | undefined)?.objectType ?? "contact";
      const portal = portalMod.maybePortalSource({
        connectorName: result.connector,
        objectType,
        id: result.id,
      });
      const portalLink = portal ? ` [Open in Wolfpack portal](${portal.url})` : "";
      return {
        answer: `✓ Created in ${result.connector}. New record id: \`${result.id}\`.${portalLink}`,
        sources: portal ? [portal] : undefined,
      };
    }
    return { answer: `I tried to create the record but the write was refused (${result.reason}). Nothing was saved.` };
  }
  if (row.tool_name === "update_external_record") {
    const mod = await import("@/lib/assistant/tools/update-external-record-tool");
    const portalMod = await import("@/lib/assistant/tools/portal-link");
    const result = await mod.executeUpdateExternalRecord(
      row.params as unknown as Parameters<typeof mod.executeUpdateExternalRecord>[0],
      { userId, userRole, workspaceId },
    );
    if (result.ok) {
      const objectType =
        (row.params as { objectType?: string } | undefined)?.objectType ?? "contact";
      const portal = portalMod.maybePortalSource({
        connectorName: result.connector,
        objectType,
        id: result.id,
      });
      const portalLink = portal ? ` [Open in Wolfpack portal](${portal.url})` : "";
      return {
        answer: `✓ Updated record \`${result.id}\` in ${result.connector}.${portalLink}`,
        sources: portal ? [portal] : undefined,
      };
    }
    if (result.reason === "ambiguous") {
      return {
        answer: `I found ${result.matchCount ?? "multiple"} matches for that name and refused to update — too ambiguous. Search first with \`find <name>\`, then update by id.`,
      };
    }
    if (result.reason === "no_match_found") {
      return {
        answer: `I couldn't find that record in the CRM. The update was not applied.`,
      };
    }
    return { answer: `I tried to update the record but the write was refused (${result.reason}). Nothing was changed.` };
  }
  return { answer: `Unknown pending action tool (${row.tool_name}); nothing executed.` };
}

/** Human-readable preview of a pending action for the confirm prompt. */
function describePendingAction(toolName: string, params: Record<string, unknown>): string {
  if (toolName === "save_team_fact") {
    const p = params as { subject?: string; attribute?: string; value?: string };
    return `save: **${p.subject ?? "?"}** → **${p.attribute ?? "?"}**: ${p.value ?? "?"}`;
  }
  if (toolName === "create_external_record") {
    const p = params as { objectType?: string; fields?: Record<string, unknown> };
    const fieldsHint = p.fields
      ? Object.entries(p.fields)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ")
      : "";
    return `create **${p.objectType ?? "?"}** in your CRM: ${fieldsHint}`;
  }
  if (toolName === "update_external_record") {
    const p = params as {
      objectType?: string;
      recordName?: string;
      fieldName?: string;
      fieldValue?: string | number | boolean;
    };
    return `update **${p.objectType ?? "?"}** "${p.recordName ?? "?"}" → ${p.fieldName ?? "?"} = ${p.fieldValue ?? "?"}`;
  }
  return `run ${toolName}`;
}

async function tryBrain(
  message: string,
  userId: string,
  userRole: string,
  conversationId: string,
): Promise<{ strong: BrainHitAnswer | null; context: BrainContext }> {
  const emptyContext: BrainContext = { hits: [], topScore: 0 };
  try {
    const result = await queryBrain({
      userId,
      userRole,
      query: message,
      limit: 5,
      conversationId,
    });
    if (result.hits.length === 0) return { strong: null, context: emptyContext };

    /* Compute context regardless of strong-hit verdict — even weak hits
       give the LLM real grounding + give the quality runner real
       topScore + validSourceIds. Dedupe by document_id so the LLM
       isn't told the same doc 3x. */
    const seen = new Set<string>();
    const ctxHits: BrainContext["hits"] = [];
    let topScore = 0;
    for (const h of result.hits) {
      if (h.score > topScore) topScore = h.score;
      const id = String(h.document_id);
      if (seen.has(id)) continue;
      seen.add(id);
      ctxHits.push({
        document_id: id,
        document_filename: h.document_filename,
        content: h.content,
        score: h.score,
      });
    }
    const context: BrainContext = { hits: ctxHits, topScore };

    // Gate: require either a semantic-blended hit OR a keyword hit with
    // reasonable tsrank score. ts_rank_cd returns values typically in
    // [0, 1]; 0.05 is a conservative floor that filters out barely-
    // tangential chunks without missing real signal.
    const strong = result.hits.filter((h) => {
      if (h.source.includes("semantic")) return true;
      return h.score >= 0.05;
    });
    if (strong.length === 0) return { strong: null, context };

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
    // Dedupe source entries by document_id so the UI doesn't render 3
    // chips that all point at the same doc when multiple chunks hit.
    const srcSeen = new Set<string>();
    const sources: AssistantSourceRef[] = [];
    for (const h of strong.slice(0, 5)) {
      const docId = String(h.document_id);
      if (srcSeen.has(docId)) continue;
      srcSeen.add(docId);
      sources.push({
        id: docId,
        title: h.document_filename,
        url: `/brain?doc=${encodeURIComponent(docId)}`,
        type: "brain",
      });
    }
    return {
      strong: {
        answer: lines.join("\n"),
        tokensUsed: result.tokens_used,
        queryLogId: result.query_log_id,
        sources,
      },
      context,
    };
  } catch {
    return { strong: null, context: emptyContext };
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
  brainContext?: BrainContext,
  /* Text extracted from the file(s) attached to THIS message. Highest-priority
     grounding: it is what the user is literally pointing at. */
  attachmentBlock?: string,
  /* A tier the user asked for by name. Passed in rather than parsed here: the
     directive is removed from the message at the top of the turn, so by the
     time it reaches this function there is nothing left to find. */
  tierOverride?: TierDirective | null,
): Promise<{ content: string; tokensUsed: number } | null> {
  /* Use the AI router (src/lib/ai/router.ts) so this works whether prod
     is configured for Anthropic OR Azure OpenAI. The previous direct-
     fetch-to-Anthropic path required ANTHROPIC_API_KEY, which is NOT
     set on Instinct's Vercel env (Azure-only). That made callAI return
     null on every request, and chat() fell through to the "I don't
     have information / Zero tokens / No match found" canned reply —
     so the LLM was effectively unreachable from /assistant on prod
     and PR #40's getRelevantContext wiring was dead code there. */
  try {
    const baseSystemPrompt = buildSystemPrompt(userRole, userMemory);

    /* Best-effort: ground the assistant's answer in the user's
       SharePoint + MS Project + meeting content via their delegated
       Graph token. Failures here (403 scope_missing, Graph 5xx,
       missing OAuth token, getRelevantContext throwing) MUST never
       block the AI call — the resolver emits its own typed analytics
       on failure and we fall back to an ungrounded answer rather than
       500'ing the chat. */
    let contextBlock = "";
    try {
      const ctx = await getRelevantContext({
        question: message,
        userId,
        role: userRole,
        surface: "assistant_support",
        maxChars: 6000,
      });
      contextBlock = ctx.rendered_prompt_block;
    } catch {
      /* swallow — keep the chat working without grounding. */
    }

    /* Inject org-learned facts (from prior user corrections) so the
       LLM treats them as ground truth. Zero LLM tokens to look up —
       it's a single indexed SQL select. */
    const facts = await findRelevantFacts(message);
    const factsBlock = renderFactsBlock(facts);

    /* Brain-hit grounding: thread weak-but-real hits into the prompt
       with stable [ref:<id>] citation markers. The LLM is instructed to
       cite via these markers when it draws on the retrieved content;
       validateCitations() in the caller strips any [ref:<id>] the LLM
       invented. The result: every surviving citation in the final
       answer points at a real, tenant-scoped doc. */
    let brainBlock = "";
    if (brainContext && brainContext.hits.length > 0) {
      const lines = ["Retrieved company-knowledge passages (cite via [ref:<id>]):"];
      for (const h of brainContext.hits.slice(0, 5)) {
        const safe = h.content.slice(0, 400).replace(/\s+/g, " ").trim();
        lines.push(
          `- [ref:${h.document_id}] "${h.document_filename}" (score ${h.score.toFixed(2)}): ${safe}`,
        );
      }
      lines.push(
        "CITATION FORMAT: When you reference any of the passages above, you MUST include the exact [ref:<id>] marker inline. DO NOT write 'Source: <filename>' or '(see <filename>)' or any other format. Use [ref:<id>] only.",
        "Example: 'The Brand Ambassador 101 training covers customer engagement [ref:abc-123].'",
        "Never invent a [ref:] you have not been given.",
      );
      brainBlock = lines.join("\n");
    }

    /* Attachment first. When somebody says "look at the screenshot", the file
       in front of them outranks anything retrieval found, and putting it last
       is how the model ended up answering from three older screenshots. */
    const systemPrompt = [attachmentBlock, factsBlock, brainBlock, contextBlock, baseSystemPrompt]
      .filter((s) => s && s.trim().length > 0)
      .join("\n");

    const aiMessages = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    /* Already stripped at the top of the turn, so `message` is what was asked. */
    const directive = tierOverride ?? null;
    const asked = message;

    const currentContent = pageContext
      ? `[Context: ${pageContext}]\n\n${asked}`
      : asked;

    aiMessages.push({ role: "user", content: currentContent });

    const start = Date.now();

    /* What this turn actually needs. Previously hardcoded to "standard", which
       meant a one-word greeting and a multi-step question with three
       screenshots attached declared the same capability floor — so the model
       registry had exactly one reachable band and the routing infrastructure
       could not express anything. Deterministic and ambiguity resolves upward,
       so a wrong guess costs a saving, never an answer. */
    const tierChoice = selectAssistantTier({
      message,
      attachmentBlock,
      historyLength: aiMessages.length,
    });

    const client = getAIClient();
    const aiResponse = await client.complete({
      messages: aiMessages,
      system: systemPrompt,
      max_tokens: 2048,
      model_tier: tierChoice.tier,
      latency_target: "real_time",
      // Govern the assistant's answers with the OGIAM Agent Constitution. The
      // router prepends it to `system` at the chokepoint.
      apply_constitution: true,
      metadata: {
        feature: "assistant_chat",
        user_id: userId,
        user_role: userRole,
        routing_reason: tierChoice.reason,
        /* "standard" is exactly what this call site sent unconditionally
           before, so the router can price the counterfactual and savings
           becomes a subtraction over real rows. */
        baseline_tier: "standard",
      },
    });

    const latencyMs = Date.now() - start;
    /* NAME THE MODEL WHEN, AND ONLY WHEN, ONE WAS ASKED FOR.
       Somebody who pins a tier is either proving the router reaches a given
       model or deliberately trading quality for cost, and both need the answer
       to say which model produced it. On every other turn this would be noise
       above every reply, which is the shape of the hedging note that had to be
       removed this morning. */
    const content = directive
      ? `${aiResponse.content}\n\n_Answered by ${aiResponse.model_used ?? "an unnamed model"}` +
        `${aiResponse.provider_used ? ` via ${aiResponse.provider_used}` : ""}` +
        ` (${tierChoice.tier} tier, as requested)._`
      : aiResponse.content;
    const tokensUsed = aiResponse.input_tokens + aiResponse.output_tokens;

    trackEvent("client.doc_generated", userId, userRole, {
      source: "assistant",
      tokens_used: tokensUsed,
      latency_ms: latencyMs,
      model: aiResponse.model_used,
      provider: aiResponse.provider_used,
      tier: tierChoice.tier,
      tier_reason: tierChoice.reason,
      module: "assistant",
    });

    return { content, tokensUsed };
  } catch (err) {
    /* NoProviderAvailableError = router has no configured provider
       (neither ANTHROPIC_API_KEY nor AZURE_OPENAI_API_KEY set). Falling
       back to null preserves the historical "I don't have information"
       UX rather than 500'ing the chat. Other errors (network, rate
       limit) also fall back. */
    if (process.env.NODE_ENV !== "production") {
      const isProviderMissing = err instanceof NoProviderAvailableError;
      console.warn(
        `[assistant.callAI] returning null — ${isProviderMissing ? "no AI provider configured" : "AI call failed"}: ${(err as Error).message}`,
      );
    }
    return null;
  }
}
