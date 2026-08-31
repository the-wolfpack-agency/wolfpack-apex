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

import {
  matchRoutine,
  runRoutine,
  describeRun,
  detectResumeIntent,
  resumeWaitingRoutine,
  pendingQuestion,
} from "@/lib/assistant/routines";
import { matchSavedRoutine } from "@/lib/assistant/routines/saved";
import { searchKnowledge, saveAnswer } from "@/lib/knowledge";
import { markCited as markBrainCited, type SemanticStatus } from "@/lib/brain/query";
import { retrieve } from "@/lib/brain/retrieve";
import { asksForSynthesis } from "@/lib/brain/question-terms";
import { detectAmbiguity } from "@/lib/brain/ambiguous-question";
import { quoteWindow } from "@/lib/brain/quote-window";
import { TurnDegradation, type DegradationKind } from "@/lib/assistant/degraded-answer";
import { judgeRelevance, RELEVANCE_MATERIAL_PER_HIT } from "@/lib/brain/relevance";
import { redactText, NEVER_QUOTE_KINDS } from "@/lib/ai/redaction";
import { looksTabular } from "@/lib/brain/query";
import { neutralizeInjection } from "@/lib/brain/security";
import { getCitationRefs } from "@/lib/brain/repo";
import { searchMeetingTranscripts } from "@/lib/plaud";

import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";
import { matchPageFacts } from "@/lib/assistant/page-facts-matcher";
import { detectSensitivePaste } from "@/lib/assistant/sensitive-paste";
import { whichOneDidYouMean } from "@/lib/assistant/which-one-did-you-mean";
import { checkPersonalDataQuestion } from "@/lib/assistant/personal-data-without-graph";
import { getValidToken } from "@/lib/microsoft-graph";
import { capabilityDenialSql } from "@/lib/assistant/capability-denial";
import { ASSISTANT_IDENTITY_PROMPT } from "@/lib/prompts/definitions/assistant-identity";
import { getTools } from "@/lib/assistant/tools/registry";
import { canInvokeTool } from "@/lib/assistant/tools/gate";
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
import { buildChoices } from "@/lib/assistant/choices";
import { gateAnswer } from "@/lib/assistant/answer-gate";
import { knownDisconnectedIntegrations } from "@/lib/assistant/disconnected-integrations";
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
import { randomUUID } from "node:crypto";
import { fenceUntrusted, type PromptPart } from "@/lib/ai/provenance";
import { carriesEnoughToQuote } from "@/lib/brain/confidence";
import { SEMANTIC_SCORE_FLOOR } from "@/lib/brain/qdrant";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * WHAT KIND OF ANSWER THIS WAS, decided where it is produced.
 *
 * WHY THIS EXISTS. The gist worked out the kind by matching the answer's
 * PROSE: "No results found for", "I could not find a clear answer", "I could
 * not reach the search index". That is fragile in the way only prose is, and
 * it cost real accuracy. Measured 2026-08-30:
 *
 *   - 14 outage answers were read as neutral, so somebody who suffered an
 *     outage was scored as satisfied
 *   - 187 model-written refusals matched no pattern at all, because the model
 *     phrases "I do not know" differently every time
 *
 * The product knew all of it at the moment it answered and threw it away.
 * Declaring it here means the gist reads a fact rather than re-deriving a
 * guess, and a NEW kind of answer is a compile-time decision rather than
 * something noticed months later in a spreadsheet.
 *
 * The prose patterns stay, as the reader for messages written before this
 * existed. They are the legacy path now, not the primary one.
 */
export type AnswerOutcomeKind =
  /** Answered from the corpus or a system. The ordinary case. */
  | "answered"
  /** Searched and genuinely held nothing. */
  | "nothing_found"
  /** Several documents fit and the product declined to guess between them. */
  | "asked_which"
  /** Something underneath was unreachable and the reader was told. */
  | "degraded"
  /** An answer was produced and the quality gate refused to show it. */
  | "low_confidence"
  /** A connected system is needed and is not connected. */
  | "not_connected";

export type AssistantSource =
  | "page_facts"
  | "knowledge_cache"
  | "user_qa_cache"
  | "analytics"
  | "meeting_transcripts"
  | "brain"
  | "tool"
  | "ai"
  /* A message the organisation sent to everybody, not an answer the assistant
     produced. Kept as its own source precisely so it can never be treated as
     one: see broadcast.ts for why that distinction is load-bearing. */
  | "broadcast"
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
  /** Which model produced an AI answer, rendered beside "AI generated" rather
   *  than written into the answer text. Absent for zero-token answers, which
   *  no model produced. */
  model?: string;
  provider?: string;
  /** Present only when the reader pinned a tier ("/cheap", "use the best
   *  model"). The badge shows the model on every AI answer; this is what lets
   *  the UI mark that this one was asked for rather than chosen. */
  tierRequested?: string;
  conversationId: string;
  messageId?: string;
  /** Personal data kinds removed at the answer boundary, so the UI can say
   *  what was taken out instead of leaving an unexplained gap. */
  redactedKinds?: string[];
  /** Which parts of the answer path did not run. Present only on a degraded
   *  turn, so the UI can style an outage differently from an empty answer and
   *  a support conversation starts from a fact rather than a guess. */
  degradedKinds?: DegradationKind[];
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

/**
 * The longest question the fuzzy cache is allowed to answer.
 *
 * WHAT THIS CACHE IS FOR. "what is our pricing model" and "what's our
 * pricing model" are the same question typed twice, and answering the
 * second from the first is free and correct. Token-set Jaccard is a good
 * test for that.
 *
 * WHAT IT IS NOT FOR. A prompt carrying a document is not a paraphrase of
 * a prompt carrying a different document, and the similarity score cannot
 * tell the difference. Two things break at once on a long prompt:
 *
 *   - The key is a set of UNIQUE tokens, so six kilobytes of claim notes
 *     collapse to about twenty words. Everything repeated contributes
 *     nothing, and the score saturates.
 *   - The question usually names the possible answers. Asking "was the
 *     verdict approved or denied" puts both words in every token set, so
 *     the one thing that decides the answer is invisible to the key by
 *     construction.
 *
 * Measured against production on 2026-08-23: two prompts identical for
 * 6,046 characters, one ending "APPROVED in full" and the other "DENIED
 * for lack of evidence", scored 0.870 and the denied claim was answered
 * "Approved" from cache, in 180ms, at zero cost. A cache that saves money
 * by answering a different question is worse than no cache.
 *
 * Above this length only the EXACT hash match can serve, which is the one
 * that cannot be wrong. The existing date/meeting bypass list stays: it
 * catches a different failure, where a short question is genuinely
 * time-bound.
 */
export const FUZZY_MAX_MESSAGE_CHARS = 400;

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
           SELECT m2.id, m2.content, m2.source, m2.tokens_used, m2.created_at,
                  /* metadata is SELECTED because the grounded filter below
                     reads a.metadata. Without it the whole statement fails
                     with "column a.metadata does not exist", the caller treats
                     the error as a cache miss, and the entire org-cache layer
                     goes quiet while looking healthy. */
                  m2.metadata
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
          /* A BROADCAST IS NOT AN ANSWER. An announcement written into every
             person's assistant is a message the organisation sent, not
             something the product worked out, and replaying it to whoever asks
             a vaguely similar question weeks later is how "submit expenses by
             Friday" becomes this company's standing answer about expenses.

             Three other conditions here happen to exclude it already: a
             broadcast records no tokens, carries no grounding, and has no user
             message in front of it. All three are incidental. Stating it
             outright means the guarantee survives someone relaxing one of
             them, which is exactly the kind of change that looks harmless. */
          AND a.source IS DISTINCT FROM 'broadcast'
          AND a.tokens_used > 0
          /* NEVER REPLAY AN ANSWER THAT STOOD ON NOTHING.
             This cache runs BEFORE every other priority, including the Brain,
             so one ungrounded answer is served to the whole workspace
             indefinitely and no later improvement to retrieval can reach that
             question. Measured 2026-08-27: "what training do brand
             ambassadors get" returned generic text about brand ambassadors in
             general, cached, while the Brain held the actual Learning Journal
             and the PCNA Academy strategy.

             ABSENT METADATA COUNTS AS UNGROUNDED. Entries written before this
             column existed cannot be shown to have stood on anything, and the
             honest reading of "we cannot tell" for an answer served to the
             whole organisation is not to serve it. That empties the existing
             cache, which is the point: it is currently full of answers nobody
             checked. */
          AND COALESCE((a.metadata->>'grounded')::int, 0) > 0
          /* Sentinel guard: never serve a "No X / not found" empty-tool
             answer from cache. Those came from narrow tool paths that
             didn't see the full data sources. The follow-up call must
             rerun the tool (now broader) or fall through to the LLM. */
          AND a.content NOT ILIKE 'No meetings recorded%'
          AND a.content NOT ILIKE 'No meetings found%'
          AND a.content NOT ILIKE 'No results found%'
          /* NEVER REPLAY AN ANSWER WE HEDGED.
             The quality gate prefixes "this answer may need a second look"
             onto anything it could not stand behind. Serving that from cache
             repeats a doubtful answer at zero tokens, for free, indefinitely,
             with none of the checks that produced the doubt in the path.
             Measured 2026-08-26: two invented terms typed once each were still
             being answered with fluent fabrications days later, hedge and all,
             because the cache does not read its own warning. */
          AND a.content NOT ILIKE '%may need a second look%'
          /* And never the canned refusal: it is an absence of an answer, not
             an answer, and caching it makes the absence permanent. */
          AND a.content NOT ILIKE '%don''t have a confident answer%'
          /* AND NEVER A DENIAL OF OUR OWN PRODUCT. Two of the three worst
             answers measured on 2026-08-28 came back from this cache, not
             from a model: "I cannot send emails directly" and "I don't have
             direct access to your file system". Both were generated once
             under a system prompt that described a different product, then
             served instantly and free ever since. Blocked on the read as
             well as the write, because a conversation is somebody's history
             and is not ours to delete. */
          AND ${capabilityDenialSql("a.content")}
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
           SELECT m2.id, m2.content, m2.source, m2.tokens_used, m2.created_at,
                  /* metadata is SELECTED because the grounded filter below
                     reads a.metadata. Without it the whole statement fails
                     with "column a.metadata does not exist", the caller treats
                     the error as a cache miss, and the entire org-cache layer
                     goes quiet while looking healthy. */
                  m2.metadata
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
          /* A BROADCAST IS NOT AN ANSWER. An announcement written into every
             person's assistant is a message the organisation sent, not
             something the product worked out, and replaying it to whoever asks
             a vaguely similar question weeks later is how "submit expenses by
             Friday" becomes this company's standing answer about expenses.

             Three other conditions here happen to exclude it already: a
             broadcast records no tokens, carries no grounding, and has no user
             message in front of it. All three are incidental. Stating it
             outright means the guarantee survives someone relaxing one of
             them, which is exactly the kind of change that looks harmless. */
          AND a.source IS DISTINCT FROM 'broadcast'
          AND a.tokens_used > 0
          /* THE SAME GUARD AS THE EXACT-MATCH QUERY ABOVE.
             I added it there, declared the cache fixed, and this fuzzy
             fallback kept serving the ungrounded answer. One function, two
             queries, one of them patched: the same shape as the regex sweep
             that missed four call sites earlier this month, and again it was
             driving the real UI that caught it rather than any test. */
          AND COALESCE((a.metadata->>'grounded')::int, 0) > 0
          /* THE SAME GUARDS AS THE EXACT MATCH ABOVE.
             This is the second lookup in this function and it had none of
             them, which is the whole reason the exclusions above appeared to
             do nothing: an invented answer that failed the exact match on
             punctuation was picked straight back up by the fuzzy one. Two
             queries against the same table, one filtered and one not, is a
             filter that only works some of the time. */
          AND a.content NOT ILIKE '%may need a second look%'
          AND a.content NOT ILIKE '%don''t have a confident answer%'
          /* AND NEVER A DENIAL OF OUR OWN PRODUCT. Two of the three worst
             answers measured on 2026-08-28 came back from this cache, not
             from a model: "I cannot send emails directly" and "I don't have
             direct access to your file system". Both were generated once
             under a system prompt that described a different product, then
             served instantly and free ever since. Blocked on the read as
             well as the write, because a conversation is somebody's history
             and is not ours to delete. */
          AND ${capabilityDenialSql("a.content")}
          AND a.content NOT ILIKE 'No meetings recorded%'
          AND a.content NOT ILIKE 'No meetings found%'
          AND a.content NOT ILIKE 'No results found%'
        ORDER BY u.created_at DESC
        LIMIT 200`,
      [ttlMs],
    );

    /* A long prompt carries data, and data is not a rephrasing. See
       FUZZY_MAX_MESSAGE_CHARS: above it the exact match has already had
       its chance and anything else is a guess with a confident voice. */
    if (message.length > FUZZY_MAX_MESSAGE_CHARS) return null;

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
// ID generation
// ---------------------------------------------------------------------------

/**
 * Identifiers for conversations, messages, memory rows and the per-turn
 * workflow id.
 *
 * WAS Math.random, under a comment saying no crypto dependency was needed.
 * That was true of the dependency and not of the requirement: these are not
 * cosmetic. A message id names a row somebody may be able to fetch, and
 * Math.random is a predictable PRNG, so an id built from it is guessable by
 * anybody who can observe a few others.
 *
 * CodeQL caught it as the value reached the answer-redaction gate: eight
 * base36 characters of Math.random flowing into a security context. The honest
 * fix is the source, not a suppression, and node:crypto is built in and
 * already used across this codebase.
 *
 * The timestamp prefix is kept because it keeps ids roughly sortable, which is
 * useful when reading a conversation in the database. Nothing parses the
 * format, so widening the random half is safe.
 */
function generateId(): string {
  const ts = Date.now().toString(36);
  return `${ts}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
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

/**
 * THE ANSWER BOUNDARY.
 *
 * chatInner has nineteen return points. Putting the gate on each of them is
 * the sweep that misses four call sites, which this codebase has already done
 * once this month. Wrapping is the only version where coverage is a property
 * of the structure rather than of my diligence.
 *
 * Everything a person is told passes here, whatever produced it: a tool, the
 * Brain, a cache, a model. The router covers roughly 8% of answers and holds
 * every outbound control; this is the other 92%.
 */
export async function chat(
  ...args: Parameters<typeof chatInner>
): Promise<AssistantResponse> {
  const res = await chatInner(...args);
  const [, userId, userRole] = args;
  const gated = gateAnswer({
    text: res.response,
    source: res.source,
    userId,
    userRole,
    workflowId: res.workflowId,
  });
  if (gated.removed.length === 0) return res;
  return {
    ...res,
    response: gated.text,
    /* Said out loud. An answer that silently lost a value reads as the
       document being incomplete; naming the removal is the difference between
       a redaction and a gap. */
    redactedKinds: gated.removed,
  };
}

async function chatInner(
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
  /* The caller's own IANA zone, sent by the browser on every turn. Threaded
     through for the same reason geo is: a server that formats times in its own
     zone tells somebody their 1pm meeting is at 5pm. */
  timeZone?: string,
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
    /* CONFIRMATION PHRASE, NOTHING TO CONFIRM.
     *
     * This used to fall through and be treated as an ordinary question, which
     * meant "yes please" was sent to the knowledge search as a QUERY. It has
     * no subject, so it keyword-matches whatever happens to be nearby, and the
     * person gets a confident "here is what the brain has on this" followed by
     * three unrelated documents. Reported 2026-08-23 with chunks of a Porsche
     * training spreadsheet returned in answer to "yes please".
     *
     * The words carry no content of their own. Answering them with a document
     * search is not a worse answer, it is an answer to a question nobody
     * asked, and it teaches somebody that the knowledge base returns noise.
     *
     * Saying the thread was lost is short, true, and recoverable. It also
     * names the likely cause, because the common way to get here is agreeing
     * to something the assistant offered in prose rather than through an
     * action it can actually take. */
    const lost =
      confirmIntent === "cancel"
        ? "Nothing was waiting on an answer, so there was nothing to cancel."
        : [
            "I have lost the thread on what you are saying yes to. Nothing was waiting for a confirmation, so I have not done anything.",
            "",
            "If it was something I offered to set up, tell me again in your own words and I will either do it or say plainly that I cannot.",
          ].join("\n");
    const lostId = await dbSaveMessage(convId, "assistant", lost, "tool", 0);
    await dbUpdateConversationStats(convId, 0);
    trackEvent("assistant.confirmation_without_pending", userId, userRole, {
      /* How often the assistant offers something it cannot actually do. A
         rising count here is a prompt problem, not a user problem. */
      intent: confirmIntent,
    });
    return {
      response: lost,
      source: "tool",
      tokensUsed: 0,
      conversationId: convId,
      messageId: lostId,
    };
  }

  /* --- Priority -3: A saved routine, before any single tool ---
   *
   * ORDER MATTERS AND IT IS NOT ARBITRARY. "run my morning" contains words
   * that several tool intents match, so if this ran after tool dispatch the
   * command would be swallowed by whichever tool matched first, and the person
   * would get a calendar instead of their morning.
   *
   * The match is exact (see catalogue.matchRoutine): a five-step chain that
   * fires at somebody who was asking a question is much worse than one that
   * failed to recognise its own name.
   *
   * A routine costs no model tokens unless one of its own steps is a model
   * step -- the point of the feature is that it operates the tools you already
   * have from one place, and asks a model only where judgement is required. */
  /* ONE CONTEXT, BOTH PATHS. A routine dispatches the same tools a message
     does, and building the context twice is how the two quietly come to
     disagree about which workspace the caller is in. */
  const toolCtx = {
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
    /* THE CALLER'S ZONE, on the shared context so a routine step and a direct
       question format the same meeting the same way. */
    ...(timeZone ? { timeZone } : {}),
  };

  /* Built-ins first, then anything this person saved. Ours are checked first so
     a saved chain can never shadow a documented command, which is also why
     saveRoutine refuses to store one that collides. */
  /* SOMEBODY COMING BACK TO A ROUTINE THAT IS WAITING ON THEM.
   *
   * Checked BEFORE a new command is matched, so "done" reaches the chain that
   * asked rather than falling through to a tool, and checked with an exact
   * vocabulary so an unrelated question in the meantime is never swallowed as
   * an answer.
   *
   * Until this existed the product told people "reply to carry on" and nothing
   * listened. A promise in the product's own words that nothing implements is
   * worse than not making it. */
  /* A RUN WAITING ON A QUESTION takes the next message as its answer, whatever
     it says. That is the opposite rule from a checkpoint pause, and correctly
     so: a question was asked, and the reply to a question is an answer. Asking
     somebody to also say a magic word first would be the product being obtuse
     about something it started. */
  const askedQuestion = await pendingQuestion(toolCtx);
  if (askedQuestion) {
    const answered = await resumeWaitingRoutine(toolCtx, "answer", undefined, message);
    if (answered) {
      const msgId = await dbSaveMessage(convId, "assistant", answered.answer, "tool", 0);
      await dbUpdateConversationStats(convId, 0);
      return {
        response: answered.answer,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
      };
    }
  }

  const resumeIntent = detectResumeIntent(message);
  if (resumeIntent !== "none") {
    const resumed = await resumeWaitingRoutine(toolCtx, resumeIntent);
    if (resumed) {
      const msgId = await dbSaveMessage(convId, "assistant", resumed.answer, "tool", 0);
      await dbUpdateConversationStats(convId, 0);
      return {
        response: resumed.answer,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
      };
    }
    /* Nothing was waiting. Fall through: "done" on its own is not a question,
       but it is also not ours to answer, and the priority chain below handles
       an ordinary message better than a guess would. */
  }

  const routine =
    matchRoutine(message) ??
    (await matchSavedRoutine({ workspaceId: workspaceId ?? "default", userId }, message));
  if (routine) {
    const run = await runRoutine(routine, toolCtx, workflowId ?? `${convId}:${Date.now()}`);
    const answer = describeRun(routine, run);
    const msgId = await dbSaveMessage(convId, "assistant", answer, "tool", 0);
    await dbUpdateConversationStats(convId, 0);
    return {
      response: answer,
      source: "tool",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  /* --- Priority -3: somebody pasted a secret and nothing else ---
   *
   * Before any tool, cache or model. The router already redacts these before a
   * prompt leaves the process, and the analytics prove it fired, so the system
   * KNOWS a card was pasted and that it removed it. Paying a model to phrase a
   * sentence about that cost 1,532 tokens on 2026-08-29 and produced "I can't
   * process credit card information directly", which leaves somebody wondering
   * what happened to the number they just typed.
   *
   * A safety answer should not be improvised either: the same paste deserves
   * the same reply today and next week, not whatever the model produces on the
   * day. Deterministic, instant, free, and it says the reassuring part.
   *
   * Only when the message is essentially JUST the value. A real question with
   * a card in it goes down the normal path, where the card is redacted and the
   * question is answered. */
  const pasted = detectSensitivePaste(message);
  if (pasted) {
    trackEvent("assistant.sensitive_paste_declined", userId, userRole, {
      kinds: pasted.kinds.join(","),
    });
    const msgId = await dbSaveMessage(convId, "assistant", pasted.answer, "tool", 0);
    await dbUpdateConversationStats(convId, 0);
    return {
      response: pasted.answer,
      source: "tool",
      tokensUsed: 0,
      conversationId: convId,
      messageId: msgId,
    };
  }

  // --- Priority -2: Deterministic tool dispatch ---
  // Phase 1 of the agentic-executor work. Before any cache / RAG / LLM,
  // try to match the question to a deterministic tool (see
  // src/lib/assistant/tools/). Tools answer parameterized questions
  // ("what do we know about X", "did <client> pay this month") by
  // reading from a typed data source, zero LLM tokens. If no tool's
  // intent matches, fall through to the existing priority chain.
  const toolResult = await tryDispatchTool(message, toolCtx);
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
    /* A REFUSAL IS READ BY A PERSON, NOT A MAINTAINER.
     *
     * This said "That tool (meeting_prep) needs a higher-privilege role than
     * yours", and the runtime error behind it read "tool good_morning_widget
     * requires role * (you have dealer_manager)". Measured 2026-08-29 by
     * asking a dealer "brief me on my next meeting" and a Center manager
     * "what is waiting on me": both perfectly reasonable questions, both
     * answered with an internal tool name and a permission grade.
     *
     * The menu is already honest, so neither role is OFFERED what it cannot
     * run. This is what happens when somebody asks anyway, which they will,
     * and it should read as an explanation rather than as a system error with
     * our internals showing.
     *
     * Names what they asked for, not what we call it. Says who can help,
     * because a refusal that leaves somebody stuck is the failure the roster
     * lookup already had to fix once. */
    const failureMsg =
      toolResult.result.code === "capability"
        ? "That is not part of what your access covers. Whoever administers this workspace can widen it, and \"what can you do\" will show everything available to you right now."
        : `I could not finish that just now. ${sanitizeRefusal(toolResult.result.message)}`;
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

  /* --- Priority -1.5: their own week, with nothing connected to read it from ---
   *
   * Placed HERE, after tool dispatch, on purpose. A tool that can answer should
   * answer, and an unconnected user asking "what are my tasks?" gets the task
   * tool's specific message rather than this general one. This is for the
   * questions that match no tool and would otherwise reach the model.
   *
   * "What did I miss this week?" was one of those. It cost 5,189ms and a model
   * call to produce "I cannot access your personal information like your
   * calendar, tasks, or emails", which reads as a policy refusal rather than
   * an unfinished setup step, and contradicts the answer the task tool gives
   * for the same underlying cause in the same minute.
   *
   * Degrades to the old behaviour on any error: an unreachable token store
   * must not cost somebody their answer, so it falls through to the model
   * exactly as before. */
  try {
    const msToken = await getValidToken(userId);
    const personal = checkPersonalDataQuestion(message, msToken !== null);
    if (personal.answer) {
      trackEvent("assistant.personal_data_unconnected", userId, userRole, {
        /* Counts how often somebody asks for their own week and cannot have
           it. Rising means onboarding is not getting people connected, which
           is a different problem from the assistant being wrong. */
        feature: "assistant",
      });
      const msgId = await dbSaveMessage(convId, "assistant", personal.answer, "tool", 0);
      await dbUpdateConversationStats(convId, 0);
      return {
        response: personal.answer,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
      };
    }
  } catch {
    /* Fall through to the model, which is what happened before this existed. */
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
  /* WHAT BROKE DURING THIS TURN, collected so the answer can say so.
   *
   * Declared HERE rather than beside the model call, because the knowledge
   * lookup below runs first and can fail first. A collector created after the
   * failure it is meant to record is worse than none: it reads as healthy.
   *
   * Per-turn rather than module state: two people asking at the same moment
   * must not inherit each other's outages. */
  const turnDegradation = new TurnDegradation();

  const knowledgeResult =
    bypassCache || hasAttachment ? null : await tryKnowledgeBase(message, turnDegradation);
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
  const {
    strong: brainResult,
    context: brainContext,
    nearMisses: brainNearMisses,
  } = await tryBrain(
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

  /* --- Priority 4b: nothing to ground an answer on ---
   *
   * Reaching here means no tool matched, no page facts hit, and the Brain
   * returned nothing. The model would be asked a question about this business
   * with no material about this business, and the only thing it can do is
   * write something plausible. That is how the assistant invented a product
   * and then remembered it as fact (#409).
   *
   * A question with concrete options moves somebody forward; an invented
   * answer moves them backward and costs a model call to do it.
   *
   * ONLY when the chips are actually RELEVANT to what was typed. buildChoices
   * falls back to declared order when nothing scores, which is right for a
   * menu after a failed answer and wrong here: offering "the first four chips"
   * to somebody asking about something else looks like relevance and leads
   * them further away. With no relevant chip this falls through to the model
   * exactly as before, so a general question still gets an answer. */
  /* WE FOUND DOCUMENTS AND COULD NOT TELL WHICH ONE. ASK.
   *
   * Placed before the generic guided path on purpose: that one offers starter
   * chips, and named files from the reader's own library are strictly better
   * than a menu when we are holding the files.
   *
   * Measured against the deployed URL 2026-08-29: "when do we have to pay?"
   * retrieves five real documents, the relevance judge rules that none answers
   * that particular question, which is fair (pay for what?), and the reader is
   * told "I don't have a confident answer, could you rephrase, or open a
   * support ticket". That is untrue, and it routes a four-word clarification to
   * a human.
   *
   * Zero tokens, because the documents are already in hand. */
  if (brainNearMisses && brainNearMisses.length > 0) {
    const ask = whichOneDidYouMean(message, brainNearMisses);
    if (ask) {
      trackEvent("assistant.asked_which_document", userId, userRole, {
        feature: "assistant",
        message_text: message.slice(0, 200),
        /* How often the corpus holds something close but the question is
           underspecified. Rising means people are asking good questions the
           product cannot yet disambiguate, which is a prompt-guidance problem,
           not a retrieval one. */
        choice_count: ask.choices.length,
        workflow_id: workflowId,
      });
      const msgId = await dbSaveMessage(convId, "assistant", ask.answer, "tool", 0, {
        outcome_kind: "asked_which" satisfies AnswerOutcomeKind,
      });
      await dbUpdateConversationStats(convId, 0);
      return {
        response: ask.answer,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
      };
    }
  }

  if (!hasAttachment && !pageContext && brainContext.hits.length === 0) {
    const disconnected = await knownDisconnectedIntegrations(userId).catch(
      () => new Set<string>(),
    );
    const guided = buildChoices(message, userRole, {
      relevantOnly: true,
      knownDisconnected: disconnected,
    });
    if (guided.length > 0) {
      trackEvent("assistant.guided_instead_of_guessing", userId, userRole, {
        message_text: message.slice(0, 200),
        choice_count: guided.length,
        module: "assistant",
        workflow_id: workflowId,
      });
      const lead =
        "I do not have anything on that yet, so I would rather ask than guess. Did you mean one of these?";
      const msgId = await dbSaveMessage(convId, "assistant", lead, "tool", 0);
      return {
        response: lead,
        source: "tool",
        tokensUsed: 0,
        conversationId: convId,
        messageId: msgId,
        workflowId,
        fallbackChips: guided.map((c) => c.query),
      };
    }
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

  if (brainContext?.semanticStatus === "failed") {
    turnDegradation.record("semantic_search", brainContext.semanticError ?? undefined);
  }

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
    turnDegradation,
  );
  if (aiResult) {
    trackEvent("system.ai_call_made", userId, userRole, {
      module: "assistant",
      tokens_used: aiResult.tokensUsed,
      workflow_id: workflowId,
    });

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
        /* Needed to tell a question about the world from one about us. */
        question: message,
        knownNames,
        /* topScore + hitCount + retrievedIds now thread through from the
           brain retrieval. Confidence gate (A1) fires when no real hits
           backed the answer. Citation gate (A3) fires when factual
           claims aren't cited. */
        topScore: brainContext?.topScore,
        topScoreIsSemantic: brainContext?.topScoreIsSemantic,
        /* The floor the index enforced, handed over rather than re-declared,
           so the gate and the retriever can never disagree about it. */
        semanticFloor: SEMANTIC_SCORE_FLOOR,
        hitCount: brainContext?.hits.length,
        retrievedIds: validSourceIds,
        /* THE TEXT THE ANSWER WAS WRITTEN FROM. A capitalised phrase the model
           read in a retrieved chunk cannot have been invented by it, and
           without this the check has only the team roster to compare against -
           so every proper noun in a client's own documents reads as a
           fabrication. Real venues in Porsche's own survey exports were being
           reported as "unfamiliar names" by a product that had ingested them
           itself. */
        groundingText: (brainContext?.hits ?? []).map((h) => h.content).join("\n"),
      },
      { userId, userRole, strictness },
    );
    /* PROMOTED TO KNOWLEDGE ONLY AFTER IT PASSES.
     *
     * This ran the moment the model replied, BEFORE any of the checks below.
     * So a fabricated answer was written into the curated knowledge base
     * unflagged, the gate then hedged the copy shown to the person, and every
     * later asking was served the original from knowledge_cache at zero tokens
     * with no gate in the path at all.
     *
     * Measured 2026-08-26: "WolfpackxPCNA" - the name of a SharePoint folder -
     * had become a knowledge entry reading "the integration between the
     * Wolfpack platform and Porsche Cars North America... inventory
     * management, pricing, incentives and lead handling". None of it exists.
     * It answered at zero tokens, indistinguishable from something a person
     * had written and approved.
     *
     * That is a poisoning loop rather than a bad answer: the model invents
     * once and the product repeats it forever, with more authority each time,
     * because a cached answer looks curated. An answer worth keeping is one
     * that survived the checks, so the write moves after them.
     */
    if (quality.verdict === "ok" && quality.flags.length === 0) {
      saveAnswer(
        message,
        citationCheck.cleanAnswer,
        "ai",
        userId,
        undefined,
        undefined,
        aiResult.tokensUsed,
      ).catch(() => {});
    } else {
      trackEvent("assistant.answer_not_promoted", userId, userRole, {
        /* How often the model produces something not worth keeping. Rising
           says the prompt or the grounding needs work, and it was invisible
           while every answer was kept regardless. */
        verdict: quality.verdict,
        flags: quality.flags.map((f) => f.filter).join(","),
      });
    }

    let safeContent = citationCheck.cleanAnswer;
    if (quality.verdict === "reject") {
      /* Append the "Try one of these instead:" lead-in so the inline
         chips the chat UI renders below have a visual anchor — without
         this, the chips appear orphaned underneath the prose. Keep the
         base lowConfidenceMessage() untouched (it's reused by tests +
         other call-sites). */
      /* AN OUTAGE IS NOT LOW CONFIDENCE.
       *
       * Measured 2026-08-30 with the semantic store unreachable and the model
       * still up: the answer came back weak, the quality gate rejected it, and
       * the reader was told "I don't have a confident answer for that. Could
       * you rephrase..." That asks somebody to reword a perfectly good
       * question to work around our outage, and it happens at the exit the
       * fallback path's honesty fix never reached.
       *
       * Half the index was missing. Saying so is both truer and more useful
       * than implying the question was the problem. */
      const outage = turnDegradation.answer();
      safeContent = outage
        ? `${outage.text}\n\nIn the meantime, these do not need it:`
        : `${lowConfidenceMessage()} Try one of these instead:`;
      if (outage) {
        trackEvent("system.assistant_answered_degraded", userId, userRole, {
          kinds: outage.kinds.join(","),
          exit: "quality_reject",
          module: "assistant",
          workflow_id: workflowId,
        });
      }
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

    /* WHETHER THIS ANSWER STOOD ON ANYTHING.
     *
     * Recorded so the org-wide cache can tell a grounded answer from a fluent
     * one. It could not, and the cost was concrete: "what training do brand
     * ambassadors get" was answered once from general knowledge, cached, and
     * then served ahead of a Brain that holds the actual Learning Journal and
     * Academy strategy. Every retrieval improvement made today was invisible
     * to any question somebody had already asked. */
    const groundedOn = (brainContext?.hits?.length ?? 0) + citationCheck.keptRefs.length;
    const msgId = await dbSaveMessage(
      convId,
      "assistant",
      safeContent,
      "ai",
      aiResult.tokensUsed,
      {
        grounded: groundedOn,
        /* DECLARED WHERE IT IS DECIDED. The quality verdict and the turn's
           degradation are both known right here, and both used to be
           recoverable only by matching the answer's prose afterwards. A
           model-written refusal phrases itself differently every time, which
           is why 187 of them were being read as ordinary answers. */
        outcome_kind: (turnDegradation.any
          ? "degraded"
          : quality.verdict === "reject"
            ? "low_confidence"
            : "answered") satisfies AnswerOutcomeKind,
      },
    );
    await dbUpdateConversationStats(convId, aiResult.tokensUsed);

    /* AI low-confidence reject path: the quality gate forced the
       deterministic low-confidence message, so the user is effectively
       in a dead-end. Surface role-tailored starter prompts as inline
       chips and fire one analytics event so we can measure how often
       the fallback affordance gets shown (numerator for chip-CTR). */
    if (quality.verdict === "reject") {
      /* CHIPS THAT ANSWER THE QUESTION THAT WAS ASKED.
         These were a fixed list per role, identical whatever somebody typed,
         so a person who asked about the build got offered the weather. Worse,
         the CTO list carried "what's our MRR", which dead-ends on a
         disconnected accounting system: a chip that cannot work is the
         role-mismatch defect wearing a friendlier coat, and it spends a click
         to teach somebody the product is broken.
         buildChoices ranks by overlap with what was typed and filters by the
         same capability gate the tools enforce, and every query it returns is
         one the prompt corpus asserts routes to a real tool. Falls back to the
         role list when nothing scores, so somebody is never left with an empty
         dead end. */
      /* Never offer a button that cannot work. QuickBooks has never held a
         token here, so "A financial figure" has been offered to everybody who
         ever saw this fallback and has never once been able to answer. */
      const disconnected = await knownDisconnectedIntegrations(userId).catch(
        () => new Set<string>(),
      );
      const ranked = buildChoices(message, userRole, {
        knownDisconnected: disconnected,
      }).map((c) => c.query);
      const fallbackChips = ranked.length > 0 ? ranked : welcomePromptTextsForRole(userRole);
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
        model: aiResult.model,
        provider: aiResult.provider,
        tierRequested: aiResult.tierRequested,
        /* The reject exit is the second place a degraded turn surfaces, and it
           was the one the first pass at this missed: the prose was made honest
           while the machine-readable signal stayed absent, so the UI could not
           tell an outage from a genuinely weak answer. */
        ...(turnDegradation.any
          ? { degradedKinds: turnDegradation.all.map((d) => d.kind) }
          : {}),
      };
    }

    return {
      response: safeContent,
      source: "ai",
      tokensUsed: aiResult.tokensUsed,
      model: aiResult.model,
      provider: aiResult.provider,
      tierRequested: aiResult.tierRequested,
      conversationId: convId,
      messageId: msgId,
      workflowId,
      ...(turnDegradation.any ? { degradedKinds: turnDegradation.all.map((d) => d.kind) } : {}),
    };
  }

  // --- Fallback ---
  /* WHAT WENT WRONG DECIDES WHICH SENTENCE IS TRUE.
   *
   * Measured 2026-08-30 with the model provider unreachable and a question
   * whose answer sits in the corpus: the reader was told "I don't have
   * information on that yet. You can help me learn by adding it to the
   * Knowledge Base." Every clause false, and the last one invites a client to
   * upload a second copy of a document the product already holds.
   *
   * The plain message survives unchanged for the healthy case, because "I have
   * nothing on that" is a good answer when it is TRUE. Dressing every empty
   * result up as an outage would be the same defect pointed backwards.
   *
   * BOTH BRANCHES KEEP THE CHIPS. An outage is exactly when somebody most
   * needs something else to try, so this chooses the prose and lets the chip
   * kit, the analytics event and the persistence below run either way. */
  const degraded = turnDegradation.answer();
  if (degraded) {
    trackEvent("system.assistant_answered_degraded", userId, userRole, {
      kinds: degraded.kinds.join(","),
      module: "assistant",
      workflow_id: workflowId,
    });
  }

  const fallbackMsg = degraded
    ? `${degraded.text}\n\nIn the meantime, these do not need it:`
    : "I don't have information on that yet. You can help me learn by adding it to the Knowledge Base, or try asking about:\n\n" +
      "- Our platforms (Instinct, Auto, Learn)\n" +
      "- Team members and roles\n" +
      "- Tech stack and infrastructure\n" +
      "- Costs and pricing\n" +
      "- Features and capabilities\n\n" +
      "The more the team adds to the knowledge base, the more I can answer without AI. Try one of these instead:";

  const msgId = await dbSaveMessage(convId, "assistant", fallbackMsg, "fallback", 0, {
    /* The fallback says one of two different things and they are not the same
       failure: an outage is broken plumbing, a genuine blank is a thin corpus,
       and only the second is fixed by connecting more sources. */
    outcome_kind: (degraded ? "degraded" : "nothing_found") satisfies AnswerOutcomeKind,
  });
  await dbUpdateConversationStats(convId, 0);

  /* Bare-fallback path (no AI provider configured / AI call returned
     null). Same chip-affordance rationale as the AI-reject branch
     above: the user otherwise gets a dead-end response. */
  const fallbackChips = welcomePromptTextsForRole(userRole);
  trackEvent("assistant.fallback_chips_offered", userId, userRole, {
    role: userRole,
    chip_count: fallbackChips.length,
    source: "fallback",
    /* Joined, because an analytics value is a scalar. The array shape belongs
       on the response, where the UI reads it. */
    ...(degraded ? { degraded_kinds: degraded.kinds.join(",") } : {}),
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
    /* Present only on a degraded turn, so the UI can style an outage
       differently from an empty answer. */
    ...(degraded ? { degradedKinds: degraded.kinds } : {}),
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

/**
 * Which knowledge entries are allowed to answer. Exported so the rule is
 * testable on its own, because it is one condition and it shipped wrong.
 */
export function pickUsableKnowledge<T extends { rating: number | null; source?: string }>(
  results: T[],
): T[] {
  return results.filter((r) => (r.rating === null ? r.source !== "ai" : r.rating > 2));
}

async function tryKnowledgeBase(
  message: string,
  /* So a failed lookup is not mistaken for an empty knowledge base. */
  degradation?: TurnDegradation,
): Promise<KnowledgeMatch | null> {
  try {
    const results = await searchKnowledge(message, 5);
    /* Unrated entries are KEPT when a person wrote them: they are fresh
       knowledge the team just added and waiting for a rating does not make
       them truer. Entries explicitly graded low (rating <= 2) are skipped.
       Walk the top matches so a slightly different phrasing still lands on a
       good entry.

       AI-AUTHORED ENTRIES ARE NOT KEPT UNTIL SOMEBODY RATES THEM, and that
       exception is the whole point. Every past model answer is saved here with
       source='ai' and no rating, so this path was replaying them at zero
       tokens under a badge that reads "From knowledge base" in green. A model
       improvisation laundered into a cited fact about the client's own
       business.

       Measured 2026-08-31: 190 of 215 rows are source='ai' and every one is
       unrated, so the comment's assumption that unrated means "just added by
       the team" was false for 88 per cent of the table. Two of twenty-three
       demo prompts hit one. "What does the brand ambassador training cover"
       returned generic dealership boilerplate that had nothing to do with this
       client, and "what issues are assigned to me" returned a model's
       suggestion to go and search GitHub by hand, complete with a real
       username, while the tool that actually lists those issues sat unused.

       A rating is a person saying it was right. Until then a model answer is
       a model answer, and the honest thing is to ask the model again with
       today's context rather than to quote yesterday's guess. */
    const usable = pickUsableKnowledge(results);
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
  } catch (err) {
    /* A FAILED LOOKUP IS NOT AN EMPTY KNOWLEDGE BASE.
     *
     * This returned null on any error, and null here means "nothing matched".
     * So a Postgres blip made the knowledge base look empty, the turn fell
     * through, and the reader was told "I don't have information on that yet"
     * about something we hold. That is the same defect the answer path was
     * fixed for on 2026-08-30, one layer down, and it would have quietly
     * recreated it. */
    degradation?.record("integration", (err as Error)?.message);
    trackEvent("system.knowledge_lookup_failed", "system", "system", {
      module: "assistant",
      error: String((err as Error)?.message ?? "unknown").slice(0, 160),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Priority 2: Analytics query
// ---------------------------------------------------------------------------

/**
 * WHEN A QUESTION IS ACTUALLY ABOUT USAGE DATA.
 *
 * Reported 2026-08-19: "what is the weather in NYC today?" answered with the
 * top ten event types from the last seven days, using zero tokens. The list was
 * a plain `.includes()` over these words, and "today" was one of them: any
 * question containing a time word was intercepted here, before the model was
 * ever asked. "What is on my calendar today", "did anything break yesterday",
 * "what happened last week" all had the same fate.
 *
 * Substring matching made it worse than the list looks. "count" is inside
 * "account", so "how do I change my account?" was an analytics question. So was
 * anything containing "total" inside "totally".
 *
 * TWO CLASSES NOW, and a time word is never enough on its own.
 *
 *   STRONG  - the question is unambiguously about usage data. Fires alone.
 *   COUNTING - asks for a quantity. Fires only alongside a subject worth
 *              counting, because "how many people are coming" is not this.
 *
 * Both are matched on WORD BOUNDARIES. Ambiguity resolves to "not analytics":
 * a missed analytics question costs one model call, while a wrong hit answers
 * a completely different question and looks broken, which is what happened.
 */
const ANALYTICS_STRONG_RE =
  /\b(analytics|stats|statistics|usage|most[- ]used|most popular|top events|event counts?|trending)\b/i;

/** Asking for a quantity. Needs a subject from the line below to count. */
const ANALYTICS_COUNTING_RE = /\b(how many|how much|count of|number of|total number)\b/i;

/** What makes a quantity question one about THIS SYSTEM's usage. */
const ANALYTICS_SUBJECT_RE =
  /\b(events?|logins?|sign[- ]?ins?|queries|questions asked|page views?|actions?|activity)\b/i;

export function isAnalyticsQuestion(message: string): boolean {
  if (ANALYTICS_STRONG_RE.test(message)) return true;
  return ANALYTICS_COUNTING_RE.test(message) && ANALYTICS_SUBJECT_RE.test(message);
}

async function tryAnalyticsQuery(
  message: string,
  userId: string,
  userRole: string,
): Promise<string | null> {
  if (!isAnalyticsQuestion(message)) return null;

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
  /** Which index produced topScore. Keyword and semantic scores are different
   *  measurements, and a threshold is meaningless without knowing which. */
  topScoreIsSemantic?: boolean;
  /**
   * WHETHER THE SEARCH ACTUALLY RAN, carried up to the answer.
   *
   * queryBrain has reported this since 2026-08-24 and only analytics read it.
   * That is why an unreachable vector store and an empty corpus produced the
   * same sentence for a person: the difference was measured, recorded, and
   * then dropped one layer below the only place it mattered.
   */
  semanticStatus?: SemanticStatus;
  /** Short reason, for the event. Never shown verbatim to a reader. */
  semanticError?: string;
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
  if (row.tool_name === "save_routine") {
    /* The end of the loop that starts with somebody describing their Monday:
       they were shown a plan, they said yes, and this is where the chain
       becomes something they can type tomorrow. */
    const p = row.params as { routine?: unknown; workspaceId?: string };
    const { saveRoutine } = await import("@/lib/assistant/routines/saved");
    const routine = p.routine as import("@/lib/assistant/routines/types").Routine | undefined;
    if (!routine || !Array.isArray(routine.steps)) {
      return { answer: "That plan is no longer in front of me, so nothing was saved. Walk me through the day again and I will rebuild it." };
    }
    const result = await saveRoutine(
      { workspaceId: p.workspaceId ?? workspaceId ?? "default", userId },
      routine,
    );
    if (!result.ok) {
      return { answer: `I could not save it: ${result.reason}. Nothing was stored.` };
    }
    const humanSteps = routine.steps.filter((s) => s.kind === "human").length;
    return {
      answer: [
        `Saved. Type **${result.command}** and I will run it.`,
        humanSteps > 0
          ? `It stops and hands back to you at ${humanSteps === 1 ? "one step" : `${humanSteps} steps`}, and nothing is sent or filed without you confirming it.`
          : "Nothing is sent or filed without you confirming it.",
      ].join(" "),
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
): Promise<{
  strong: BrainHitAnswer | null;
  context: BrainContext;
  /**
   * Documents that came back and were judged not to answer THIS question.
   *
   * Kept rather than discarded because they are the best thing we have when we
   * cannot answer: real files from the reader's own library, named. A generic
   * "could you rephrase" throws that away and tells somebody to open a ticket
   * about documents we are holding in our hand.
   */
  nearMisses?: string[];
}> {
  const emptyContext: BrainContext = { hits: [], topScore: 0, topScoreIsSemantic: false };
  try {
    /* THE SAME ENTRY POINT THE EVAL GRADES.
     *
     * retrieve() owns the order of operations — retrieve, optionally judge,
     * optionally ask again in other words — and the eval calls it too. While
     * the assistant called queryBrain directly and the eval called something
     * else, the eval graded a path the product does not take, which is how
     * query expansion shipped unproven: its trigger is a judge rejection and
     * the harness never judged.
     *
     * No judge and no expander passed here, so behaviour is byte-for-byte what
     * it was: retrieve() with neither is plain retrieval. The judge still runs
     * below, where it always has. This is the wiring, not the behaviour
     * change, and the two are worth keeping separate. */
    const { execution: result } = await retrieve({
      userId,
      userRole,
      query: message,
      limit: 5,
      conversationId,
    });
    /* THE LAST HIDING PLACE.
     *
     * Measured against the deployed URL 2026-08-29, one turn, no exception:
     *
     *   20:13:22.744  brain_query_log   "when do we have to pay?"  ->  5 hits
     *   20:13:23.446  intent_unmatched  same question              ->  has_brain_context false
     *
     * queryBrain logs hitChunkIds.length and returns that same array, the loop
     * below cannot turn five hits into none, and tryBrain did not throw. Each
     * of those is verified, and together they are impossible, so one of them is
     * not what it appears.
     *
     * This records what THIS function actually received, which is the only
     * number nobody has seen. Five hypotheses have died guessing at it: the
     * score floor, the query phrasing, whether semantic ran, an unguarded
     * analytics await, and an exception being swallowed. */
    trackEvent("assistant.brain_lookup_returned", userId, userRole, {
      feature: "assistant",
      message_text: message.slice(0, 200),
      returned_hits: result.hits.length,
      keyword_hits: result.keyword_hits,
      semantic_hits: result.semantic_hits,
      /* Joins this to brain_query_log directly, rather than by timestamp,
         which is how the two records stayed ambiguous for so long. */
      query_log_id: result.query_log_id,
    });
    if (result.hits.length === 0) {
      /* THE CASE THAT MATTERED MOST WAS THE ONE THROWING THE SIGNAL AWAY. An
         unreachable index is exactly what produces zero hits, and this
         returned a context that said nothing about why. */
      return {
        strong: null,
        context: { ...emptyContext, semanticStatus: result.semantic_status },
      };
    }

    /* Compute context regardless of strong-hit verdict — even weak hits
       give the LLM real grounding + give the quality runner real
       topScore + validSourceIds. Dedupe by document_id so the LLM
       isn't told the same doc 3x. */
    const seen = new Set<string>();
    const ctxHits: BrainContext["hits"] = [];
    let topScore = 0;
    let topScoreIsSemantic = false;
    for (const h of result.hits) {
      if (h.score > topScore) {
        topScore = h.score;
        topScoreIsSemantic = h.source.includes("semantic");
      }
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
    const context: BrainContext = {
      hits: ctxHits,
      topScore,
      topScoreIsSemantic,
      semanticStatus: result.semantic_status,
    };

    // Gate: require either a semantic-blended hit OR a keyword hit with
    // reasonable tsrank score. ts_rank_cd returns values typically in
    // [0, 1]; 0.05 is a conservative floor that filters out barely-
    // tangential chunks without missing real signal.
    /* A KEYWORD-ONLY MATCH IS NOT EVIDENCE THE DOCUMENT IS ABOUT THE QUESTION.
     *
     * Measured against the real index on 2026-08-24, ts_rank_cd put "yes" at
     * 0.5000, "ok do that" at 0.4000 and "thanks" at 0.3000: the three highest
     * scores in the sample, above every genuine question, while a real question
     * about time-off policy scored 0.0404 and was rejected. The score tracks how
     * short the query is, not how relevant the chunk is, so no floor separates
     * them. That is how "start my day" came back with a chunk of a Porsche
     * mobile coaching spreadsheet.
     *
     * Semantic hits are exempt: an embedding match IS evidence of aboutness.
     * Which matters more than it looks, because on the same day the production
     * log showed 252 brain queries in 30 days and NOT ONE semantic hit, so in
     * practice every answer here has been taking the keyword branch. */
    const quotable = carriesEnoughToQuote(message);
    const strong = result.hits.filter((h) => {
      /* SEMANTIC IS EXEMPT FROM THE SUBJECT-WORD TEST, NOT FROM HAVING TO BE
         CLOSE. Qdrant already refuses anything under SEMANTIC_SCORE_FLOOR, and
         this repeats the check because the exemption is only safe while that
         floor exists: for one afternoon it did not, and every query on record
         came back with five confident hits. Belt and braces on the one branch
         that answers without asking anything else. */
      if (h.source.includes("semantic")) return h.score >= SEMANTIC_SCORE_FLOOR;
      return quotable && h.score >= 0.05;
    });
    if (strong.length === 0) return { strong: null, context };

    /* DID IT FIND THE RIGHT THING, OR MERELY SOMETHING?
     *
     * Every gate above this line is a rule about SHAPE - how many hits, what
     * score, how long the query was. A confident wrong retrieval passes all of
     * them, because it reads perfectly. #386 built the judge that can tell the
     * difference, measured it, and never called it: judgeRelevance was
     * imported by its own test and nothing else, so the Brain went on quoting
     * whatever cleared the score floor.
     *
     * What that looks like in production, reported 2026-08-25: a message about
     * generating meeting briefs was answered with three chunks of Porsche
     * Brand Ambassador training PDFs, at five semantic hits and full
     * confidence. Nothing in the numbers said anything was wrong.
     *
     * Judged only when we are ABOUT TO QUOTE, so the cost lands on the turns
     * that would otherwise be confidently wrong rather than on every query.
     * One cheap-tier call, which is the argument the router exists to make. */
    /* ENOUGH OF EACH CHUNK THAT THE JUDGE CAN SEE THE ANSWER.
     *
     * This showed the first 500 characters of each hit. Measured against the
     * real corpus 2026-08-29, the median chunk is 2,262 characters and the
     * longest is 2,627, so the judge was shown roughly the first fifth of each
     * document: headers, titles and boilerplate.
     *
     * What that did, on the chunk holding the answer to "how much do we owe
     * upfront?":
     *
     *   chunk length      2,589 characters
     *   "30 days" at      position 741      -> past the cutoff
     *   "50%" at          position 2,101    -> past the cutoff
     *
     * Both figures were outside the window. The judge ruled IRRELEVANT on what
     * it had been shown, correctly, and tryBrain then discarded the context.
     * gateUngroundedClaimAboutUs reads an empty context as "nothing retrieved"
     * and rejects, so the reader got "I don't have a confident answer" for a
     * question the corpus answers in one line.
     *
     * It fired 123 times between 2026-08-25 and 2026-08-29.
     *
     * SIZED TO THE CORPUS, not guessed: 2,400 covers a whole median chunk and
     * nearly the longest. Three hits is about 7,000 characters, roughly 1,800
     * input tokens on the cheap tier, which is a fraction of a cent on the
     * turns that would otherwise be confidently wrong or wrongly refused. The
     * whole argument for the judge was that this is the cheapest place to
     * spend, and starving it of the text defeated that. */
    const material = strong
      .slice(0, 3)
      .map((h) => h.content.slice(0, RELEVANCE_MATERIAL_PER_HIT))
      .join("\n\n");
    const relevance = await judgeRelevance(message, material, async (input) => {
      const res = await getAIClient().complete({
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        max_tokens: input.maxTokens,
        model_tier: "cheap",
        metadata: { feature: "brain.retrieval_relevance", user_id: userId, user_role: userRole },
      });
      return res.content;
    });

    if (relevance.verdict === "irrelevant") {
      trackEvent("brain.retrieval_judged_irrelevant", userId, userRole, {
        /* What the shape-based gates let through. A rising count is the score
           floor being wrong, not the judge being expensive. */
        hits: strong.length,
        top_score: Number(topScore.toFixed(4)),
        semantic_hits: result.semantic_hits,
        keyword_hits: result.keyword_hits,
      });
      /* THE CONTEXT GOES TOO. Having decided this material does not answer the
         question, handing it to the model as grounding would be the same
         mistake one layer down, and the model would quote it with our
         confidence rather than its own.
         
         THE FILENAMES DO NOT GO. They are not grounding and cannot be quoted
         from, so none of the reasoning above applies to them, and they are the
         difference between "I could not answer" and "I found these three, which
         did you mean". Deduplicated, because four chunks of one document is one
         document to the person reading. */
      const nearMisses = [...new Set(strong.map((h) => h.document_filename))].slice(0, 4);
      return { strong: null, context: emptyContext, nearMisses };
    }

    // Format zero-LLM-token response. Each chunk is passed through
    // neutralizeInjection() so a hostile document containing
    // "Ignore previous instructions" can't influence a future LLM turn
    // that includes this message in its history. Matched patterns are
    // replaced with [filtered:<label>] tags so the user can see what
    // was flagged and the brain_query_log row records the labels.
    /* A SPREADSHEET IS GOOD GROUNDING AND A BAD QUOTE.
     *
     * Verbatim quoting is right for prose: it is fast, free, and the document
     * says it better than a paraphrase would. It is wrong for a spreadsheet,
     * which chunks as raw CSV and prints column headers, UUIDs, usernames and
     * participant names into the chat. Measured on the real assistant, "which
     * hotels were surveyed in August" answered with a row containing a named
     * dealer GM and their username.
     *
     * The same hits handed to a model come back as "Ritz Carlton, Aug 17:
     * accommodations were very nice", which is what somebody asked for. So
     * when the strong hits are mostly tabular, this declines to answer here
     * and lets the grounded model path do it. Costs a cheap-tier call and buys
     * an answer a client can read. */
    /* WEAK AND CONTESTED EVIDENCE IS NOT AN ANSWER.
     *
     * Measured 2026-08-30: "how much do we owe upfront?" quoted a chauffeur
     * invoice, confidently, with a dollar figure. "when do we have to pay?"
     * correctly replied "the closest things I hold are... name it". Same shape
     * of question, opposite behaviour, and the first is a wrong answer given
     * with the product's full confidence.
     *
     * The existing guard only fires when the relevance judge REJECTS the hits.
     * Here the judge accepted, and was right to: an invoice genuinely is
     * relevant to owing money. Relevance was never the problem. Agreement was.
     * Neither question names a subject, so several documents answer equally
     * and picking one is a guess wearing a citation.
     *
     * Falls through to the same near-miss path the judge-rejection case uses,
     * so there is one way of saying "which did you mean" rather than two. */
    const ambiguity = detectAmbiguity(strong);
    if (ambiguity) {
      trackEvent("assistant.brain_answer_contested", userId, userRole, {
        candidates: ambiguity.candidates.length,
        top_score: Number((strong[0]?.score ?? 0).toFixed(4)),
        module: "assistant",
      });
      return { strong: null, context: emptyContext, nearMisses: ambiguity.candidates };
    }

    /* A SUMMARY IS NOT THREE EXCERPTS.
     *
     * The quote path below is the right answer to "what does the SOW say about
     * payment": the clause is in one chunk, quoting it costs nothing, shows its
     * source and cannot invent anything. It is the wrong answer to "summarise
     * the SOW", where what was asked for exists in no single chunk. Measured on
     * 2026-08-30, that question returned a filename, the words "chunk 2", and
     * 500 characters of the middle of a subscription clause. Summary-shaped,
     * and not a summary.
     *
     * It declines the same way the tabular case does, for the same reason and
     * through the same seam: context still flows, so the model answers FROM
     * these documents rather than from memory. Declining to quote is not
     * declining to answer. */
    if (asksForSynthesis(message)) {
      trackEvent("assistant.brain_quote_declined_for_synthesis", userId, userRole, {
        strong_hits: strong.length,
        module: "assistant",
      });
      return { strong: null, context };
    }

    const tabularCount = strong.filter((h) => looksTabular(h.content)).length;
    if (tabularCount > strong.length / 2) {
      trackEvent("assistant.brain_quote_declined_tabular", userId, userRole, {
        strong_hits: strong.length,
        tabular_hits: tabularCount,
        module: "assistant",
      });
      /* Context still flows, so the model answers FROM these documents rather
         than from memory. Declining to quote is not declining to answer. */
      return { strong: null, context };
    }

    const lines: string[] = [
      "Here's what the brain has on this:",
      "",
    ];
    const allMatchedLabels = new Set<string>();
    const redactedKinds = new Set<string>();
    for (const h of strong.slice(0, 3)) {
      /* Trimmed to word and sentence boundaries rather than a bare character
         count, which used to open quotes mid-word: "tation and Project
         Management fees" is the tail of "Documentation". */
      const windowed = quoteWindow(h.content, 500);
      const raw = windowed.text;
      const { text: injectionSafe, matchedLabels } = neutralizeInjection(raw);
      for (const l of matchedLabels) allMatchedLabels.add(l);
      /* AND THE PEOPLE IN IT. neutralizeInjection defends the MODEL from a
         hostile document; it does nothing for the person named inside an
         ordinary one. A survey export chunks as raw CSV, so quoting it
         verbatim printed a.person@example-dealer.com and another.person@example.com
         into the chat, along with participant names and roles.
       *
         This path spends zero tokens, which is the product working as
         designed, and is why it never reached the outbound redactor in the
         router: the cheapest answers were the only unredacted ones. */
      const outbound = redactText(injectionSafe, NEVER_QUOTE_KINDS);
      const safe = outbound.text;
      if (outbound.redacted) {
        for (const hit of outbound.hits) redactedKinds.add(hit.kind);
      }
      /* NO CHUNK INDEX. "(chunk 7)" is how this product stores a document,
         not anything a reader can act on: there is no chunk 7 to go and look
         at, and naming one in a client-facing answer reads as debug output
         that escaped. The filename is the part somebody can actually open. */
      lines.push(`**${h.document_filename}**`);
      /* Ellipses on the sides that were actually trimmed, so an excerpt looks
         like an excerpt and a complete passage does not pretend to be one. */
      lines.push(
        `> ${windowed.trimmedStart ? "…" : ""}${safe}${windowed.trimmedEnd ? "…" : ""}`,
      );
      lines.push("");
    }
    const sourcesLine =
      `*Sources: ${strong.length} brain chunk${strong.length === 1 ? "" : "s"}, ` +
      `${result.keyword_hits} keyword · ${result.semantic_hits} semantic · ` +
      `${result.latency_ms}ms` +
      (allMatchedLabels.size > 0 ? ` · filtered: ${[...allMatchedLabels].join(",")}` : "") +
      /* Said out loud. A quote that silently lost a column reads as the
         document being incomplete; naming the removal is the difference
         between a redaction and a gap. */
      (redactedKinds.size > 0 ? ` · removed: ${[...redactedKinds].sort().join(",")}` : "") +
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
  } catch (err) {
    /* SAY WHY, BECAUSE THIS SWALLOWED FOUR DIAGNOSES.
     *
     * This catch was bare. Anything failing inside queryBrain came back as an
     * empty context, which gateUngroundedClaimAboutUs reads as "nothing was
     * retrieved" and rejects the answer as ungrounded. So a broken retrieval
     * and an empty corpus produced the same sentence for the reader and the
     * same record for us.
     *
     * Measured against the deployed URL 2026-08-29:
     *
     *   brain_query_log  "how much do we owe upfront?"  ->  4 hits
     *   quality gate     same question                  ->  hit_count 0
     *
     * Both true at once, and there was no way to tell whether queryBrain had
     * returned nothing or had thrown on the way. Four hypotheses died against
     * that gap: the score floor, the query phrasing, whether semantic ran at
     * all, and an unguarded analytics write. Each was plausible, each was
     * measured, and none of them was this.
     *
     * The failure stays non-fatal, which is right. It stops being invisible,
     * which was not. */
    trackEvent("assistant.brain_lookup_failed", userId, userRole, {
      feature: "assistant",
      message_text: message.slice(0, 200),
      /* The message, not the stack: a reader needs to know which dependency
         gave out, and the class plus first line says that without storing a
         trace on an analytics row. */
      error: (err as Error)?.message?.slice(0, 200) ?? "unknown",
      error_name: (err as Error)?.name ?? "unknown",
    });
    return { strong: null, context: emptyContext };
  }
}

// ---------------------------------------------------------------------------
// Priority 5: AI call
// ---------------------------------------------------------------------------

/**
 * Strip our internals out of a failure a person is about to read.
 *
 * Tool names, role grades and capability strings are how the system talks
 * about itself. In a message to somebody who just asked a question they read
 * as a stack trace, and they tell a client nothing they can act on.
 *
 * Keeps the sentence when there is nothing internal in it, because a genuine
 * reason ("Microsoft is not connected yet") is worth passing through intact.
 */
export function sanitizeRefusal(message: string): string {
  const cleaned = message
    /* "tool good_morning_widget requires role * (you have dealer_manager)" */
    .replace(/\btool\s+[a-z0-9_]+\s+requires\s+role\s+\S+\s*(\(you have [^)]*\))?/gi, "")
    /* Bare snake_case tool names anywhere else in the sentence. */
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+){1,}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:,.-]+/, "")
    .trim();
  return cleaned.length > 3
    ? cleaned
    : "Try asking a different way, or type \"what can you do\" to see what is available to you.";
}

function buildSystemPrompt(
  userRole: string,
  userMemory: UserMemoryEntry[],
  conversationSummary?: string,
): string {
  /* IDENTITY COMES FROM THE PROMPT REGISTRY, not from a string typed here.
     What used to be on this line named the wrong product, described a
     different client's platform, and told the model nothing about what it
     could do, so it answered capability questions as a generic chatbot with
     access to nothing. prompts/definitions/assistant-identity.ts carries the
     old text and what it cost.

     The capability half is read from the LIVE tool registry through the same
     role gate the dispatcher enforces, so the sentence the model is given IS
     the set of tools that will run. A typed list drifts the day somebody adds
     a tool, which is precisely how the old string survived a product rename. */
  const usableTools = getTools()
    .filter((t) => canInvokeTool(userRole, t.capability))
    .map((t) => t.name);

  const parts: string[] = [
    ASSISTANT_IDENTITY_PROMPT.render({ userRole, capabilities: usableTools }),
  ];

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
  /* What broke during this turn, so the answer can say so. */
  degradation?: TurnDegradation,
): Promise<{
  content: string;
  tokensUsed: number;
  /** Which model produced the answer, for the badge row beside "AI generated". */
  model?: string;
  provider?: string;
  /** Set only when the reader pinned a tier by name. Every turn has a model;
   *  naming it on every turn is noise, and the reader who asked for a specific
   *  one is the reader who needs to see it. */
  tierRequested?: string;
} | null> {
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

    /* CONTENT WE FETCHED IS DATA, AND SITS INSIDE A FENCE.
     *
     * The attachment text and the retrieved passages used to be concatenated
     * straight into the SYSTEM prompt, which is the most trusted position in
     * the entire request: the place our own instructions live. A supplier's PDF
     * or a retrieved document that contains "ignore previous instructions" was
     * therefore delivered to the model as though we had written it.
     *
     * Neither is our words. Both are content fetched on the user's behalf, so
     * both are quarantined by provenance (see lib/ai/provenance.ts) and
     * announced to the model as data to read rather than directions to follow.
     *
     * OUR instructions about that data stay OUTSIDE the fence: the citation
     * format is genuinely ours, and burying it inside a block the model is told
     * not to obey would break citations to fix an injection. */
    const untrusted: PromptPart[] = [];
    if (attachmentBlock && attachmentBlock.trim()) {
      untrusted.push({ provenance: "attachment", label: "attached file", text: attachmentBlock });
    }
    if (brainContext && brainContext.hits.length > 0) {
      for (const h of brainContext.hits.slice(0, 5)) {
        untrusted.push({
          provenance: "retrieved",
          label: h.document_filename,
          text: `[ref:${h.document_id}] ${h.content.slice(0, 400).replace(/\s+/g, " ").trim()}`,
        });
      }
    }
    const fenced = fenceUntrusted(untrusted);

    if (fenced.attempts.length > 0) {
      /* Somebody's document tried to give the assistant orders. The fence
         already made it inert; this is so a person finds out, because a
         supplier PDF that does this is worth a conversation. Never the text
         itself: a report that quotes the payload delivers it again. */
      trackEvent("ai.injection_attempt_blocked", userId, userRole, {
        module: "assistant",
        attempts: fenced.attempts.length,
        sources: [...new Set(fenced.attempts.map((a) => a.provenance))].sort().join(","),
      });
    }

    /* Citation instructions only: the passages themselves are in the fence. */
    const citationRules =
      brainContext && brainContext.hits.length > 0
        ? [
            "CITATION FORMAT: When you reference any quarantined passage above, you MUST include its exact [ref:<id>] marker inline. DO NOT write 'Source: <filename>' or any other format.",
            "Never invent a [ref:] you have not been given.",
          ].join("\n")
        : "";

    const systemPrompt = [fenced.text, citationRules, factsBlock, contextBlock, baseSystemPrompt]
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
    /* AN OVERRIDE IS OBEYED HERE, not inferred back out of the message.
       selectAssistantTier parses "/cheap" itself, and that worked only while
       the directive was still in the text. Stripping it at the top of the turn
       (so anchored tool patterns could match) severed the only channel it had:
       by the time it ran, the message was clean, so it INFERRED a tier from
       the question and the override was silently dropped.

       Reported 2026-08-19: "/cheap is today's weather high or lower than 25
       years ago?" ran at standard, because the question reads like a
       comparison. My own fix caused it, and the badge then reported the
       inferred tier as "as asked", which is the worse half: a false statement
       made confidently. */
    const tierChoice = tierOverride
      ? { tier: tierOverride.tier, reason: "user_override" as const }
      : selectAssistantTier({
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
      /* CHECK THE ANSWER BEFORE THE PERSON READS IT.
       *
       * The router has carried an answer-quality layer for months - rule
       * checks for empty, truncated, deferred, ignored-question and
       * placeholder answers, a model judge above them, and escalation to a
       * better tier when a model tried and fell short. All of it is gated on
       * `verify`, and NOTHING IN THE PRODUCT HAS EVER SET IT. Production has
       * 257 completions and zero ai.answer_judged events: not one assistant
       * answer has ever been checked before somebody read it.
       *
       * Rule-based checking is free - no second call, no tokens - so there is
       * no argument for leaving it off. Deep judging is deliberately not on
       * here: it costs a second call, and it needs a model from a different
       * family to be worth anything, which this deployment does not have yet.
       * Turning it on today would buy a small model marking its own homework,
       * which is the weakest form of this idea and reads as assurance. */
      verify: true,
      /* And let a second model read every answer before a person does.
         "always" rather than true, and the difference is the whole control.
         `true` asks the reviewer only when the free rules are unsatisfied, and
         the free rules catch shape: empty, truncated, refused, deferred,
         placeholder. A competent model does not produce those. Production bore
         that out exactly: 28 verified assistant answers, 28 sufficient, the
         reviewer ran zero times while the playbook told clients a second model
         reads every answer.
         The failure worth catching here is the other kind, an answer that is
         well formed and confident and wrong, or that answered half the
         question. That is the judgement verification.ts says a rule cannot
         make. Reviewing every answered question is what makes the claim true,
         and at this volume the cost is a rounding error against a bill that
         ran to 43 cents in sixty days. */
      improve: "always",
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
    /* WHICH MODEL ANSWERED IS METADATA, NOT PROSE.
       This appended "_Answered by gpt-4o-mini via azure-openai_" to the text
       itself. It read as part of the reply, it copied out with the reply, and
       it landed inside the same block as the answer-quality note. It belongs in
       the row where "AI generated" and the token count already are, so it is
       returned as a field and rendered there. Reported 2026-08-19. */
    const content = aiResponse.content;
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

    return {
      content,
      tokensUsed,
      model: aiResponse.model_used ?? undefined,
      provider: aiResponse.provider_used ?? undefined,
      /* The tier ASKED FOR, not the tier chosen. They are the same now that an
         override is honoured, and the field must mean what its name says or it
         will drift apart from the truth again the next time these differ. */
      tierRequested: tierOverride?.tier,
    };
  } catch (err) {
    /* NoProviderAvailableError = router has no configured provider
       (neither ANTHROPIC_API_KEY nor AZURE_OPENAI_API_KEY set). Falling
       back to null preserves the historical "I don't have information"
       UX rather than 500'ing the chat. Other errors (network, rate
       limit) also fall back. */
    const isProviderMissing = err instanceof NoProviderAvailableError;
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[assistant.callAI] returning null — ${isProviderMissing ? "no AI provider configured" : "AI call failed"}: ${(err as Error).message}`,
      );
    }
    /* SAY WHY, BUT ONLY WHEN IT IS ACTUALLY A FAILURE.
     *
     * Returning a bare null made "the model could not be reached" identical to
     * "we have nothing on that", and the caller told the reader the second
     * one. Recording the reason fixes that.
     *
     * NO PROVIDER CONFIGURED IS NOT AN OUTAGE. This product has a designed
     * no-AI mode: the plain fallback's own wording ("the more the team adds to
     * the knowledge base, the more I can answer without AI") describes exactly
     * that state, and it is what tests and local development run in. Calling
     * it degraded would tell somebody to try again in a minute for a condition
     * that will still be true next month. A missing provider is a deployment
     * decision; an unreachable one is an outage. */
    if (!isProviderMissing) {
      degradation?.record("model", (err as Error).message);
    }
    trackEvent("system.assistant_model_unreachable", userId, userRole, {
      reason: isProviderMissing ? "no_provider_configured" : "call_failed",
      module: "assistant",
    });
    return null;
  }
}
