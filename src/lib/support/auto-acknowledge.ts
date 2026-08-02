/**
 * support / auto-acknowledge — immediate "we got your email" reply.
 *
 * The support@ inbox poller runs on a 5-minute cadence. By the time an
 * operator reviews + sends a real draft, a customer can be sitting in the
 * dark for upwards of 10 minutes. This module closes that gap by sending
 * a polite, narrowly-scoped acknowledgement WITHIN 30 seconds of the
 * email landing — but ONLY when:
 *
 *   1. The ticket came in over email (graph_message_id is set), and
 *   2. The ticket audience is `client` (we never auto-reply to teammates),
 *   3. A pattern in the library matched AND has
 *      `auto_acknowledge_enabled = true` AND a non-empty
 *      `auto_acknowledge_template`,
 *   4. The body does not contain a blocklist keyword (legal, breach,
 *      lawsuit, ceo, refund, cancel, etc.).
 *
 * The auto-ack is intentionally narrow: it acknowledges receipt, echoes
 * what the customer described in the customer's own words, offers 2-4
 * GENERAL self-serve steps from the pattern's auto_acknowledge_template,
 * and tells the customer a Wolfpack teammate will follow up. It NEVER
 * asserts facts about the customer's account state ("your account is
 * locked", "your license expired"). The operator's review-and-send flow
 * is unchanged — auto-ack runs alongside it, not instead of it.
 *
 * Lessons learned (the "Lorena hallucination"): we enforce the no-state-
 * assertion rule three ways:
 *   - The system prompt explicitly forbids it.
 *   - A runtime guard scans the AI output for forbidden phrases ("your
 *     account is", "your license is", "you are locked out of", etc.) and
 *     falls back to a safe generic message when it sees one.
 *   - The pattern.auto_acknowledge_template is a SAFER, narrower variant
 *     than the full draft_template — operators author it specifically
 *     for unsupervised replies.
 *
 * This module never throws. Every public function returns a structured
 * result. The caller (inbox poller) wraps the orchestrator in
 * try/catch + obs.recordError as belt-and-braces.
 */

import { getAIClient } from "@/lib/ai";
import type { AIMessage } from "@/lib/ai";
import {
  cacheResponse,
  lookupCachedResponse,
} from "@/lib/ai/response-cache";
import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { getObsClient } from "@/lib/obs";

import {
  appendTicketReply,
  getTicket,
  listEnabledPatterns,
  markTicketAutoAcknowledged,
  setTicketCacheIds,
} from "./repo";
import { findMatchingPatterns } from "./pattern-library";
import type { SupportPattern, SupportTicket } from "./types";
import { renderPrompt } from "@/lib/prompts/registry";
import { SUPPORT_AUTO_ACKNOWLEDGE } from "@/lib/prompts/definitions/support";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SUPPORT_FROM = "support@thewolfpack.agency";
const TICKET_BODY_TRUNCATE = 1500;
const MAX_AUTO_ACK_TOKENS = 600;

/**
 * Substrings that, when present in a ticket body (case-insensitive),
 * disqualify the ticket from auto-acknowledgement. We never want a bot
 * reply landing on top of a legal threat, a refund request, or an
 * incident report. Operator must handle those manually.
 *
 * The list is intentionally short and conservative; over-blocking simply
 * means the customer gets the slower (5 min cron) draft path, which is
 * still a fine fallback.
 */
const BLOCKLIST_KEYWORDS: readonly string[] = [
  "lawsuit",
  "legal",
  "attorney",
  "ceo",
  "data breach",
  "subpoena",
  "complaint",
  "refund",
  "cancel",
];

/**
 * Forbidden output phrases — the AI must never assert these about the
 * customer's account. Detected via a case-insensitive substring scan on
 * the generated body. When any are present we fall back to a safe
 * generic message rather than risk a Lorena-style hallucination.
 *
 * Keep this list aligned with the system prompt below.
 */
const FORBIDDEN_OUTPUT_PHRASES: readonly string[] = [
  "your account is",
  "your license is",
  "you are locked out",
  "you're locked out",
  "we have fixed",
  "we've fixed",
  "we have resolved",
  "we've resolved",
  "this is fixed",
  "this is resolved",
  "your password is",
];

 
/* Prompt lives in the registry: src/lib/prompts/definitions/support.ts. */
const SYSTEM_PROMPT: string = renderPrompt(SUPPORT_AUTO_ACKNOWLEDGE, {});
 

/**
 * Generic fallback used when:
 *   - The AI errors out, OR
 *   - The AI returns empty content, OR
 *   - The AI output trips a forbidden-phrase guard.
 *
 * Bare-minimum acknowledgement, makes no claims, defers everything to
 * the operator. Safe to send unsupervised.
 */
const SAFE_FALLBACK_BODY = [
  "Hi there,",
  "",
  "Thanks for reaching out. We received your message and a Wolfpack team member will follow up shortly.",
  "",
  "If you have additional details or screenshots, feel free to reply to this thread and we will pick it up.",
  "",
  "The Wolfpack Team",
].join("\n");

/* ------------------------------------------------------------------ */
/* Gate                                                                */
/* ------------------------------------------------------------------ */

/**
 * Decide whether a ticket should receive an auto-acknowledgement reply.
 * Pure function — no I/O, safe to unit test exhaustively.
 *
 * Returns true ONLY if every gate is satisfied. See module header for
 * the spec. When false, the caller short-circuits and the ticket waits
 * for the regular operator-review flow.
 */
export function shouldAutoAcknowledge(
  ticket: SupportTicket,
  pattern: SupportPattern | null,
): boolean {
  /* Audience gate: only external customers ever get an auto-ack.
     Internal teammates get the regular draft flow. */
  if (ticket.audience !== "client") return false;

  /* Email-source gate: graph_message_id is the marker that this ticket
     came from the support@ inbox poller. Manual /support form tickets
     do not get an auto-ack — there is no inbound email to reply to. */
  if (!ticket.graph_message_id) return false;

  /* Pattern gate: a pattern must be matched AND opted into auto-ack.
     The pattern's auto_acknowledge_template is the safer narrower
     variant the AI uses as the starting point. */
  if (!pattern) return false;
  if (!pattern.auto_acknowledge_enabled) return false;

  /* Blocklist gate: case-insensitive substring scan against the body.
     We deliberately do NOT scan the title — too many false negatives
     and the body is what humans actually wrote. */
  const bodyLower = (ticket.body ?? "").toLowerCase();
  for (const kw of BLOCKLIST_KEYWORDS) {
    if (bodyLower.includes(kw)) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* AI generation                                                        */
/* ------------------------------------------------------------------ */

export interface AutoAcknowledgeDraft {
  subject: string;
  body: string;
  /**
   * Cache row id this auto-ack was either served from (cache hit) or
   * saved into (cache miss). Stored on the ticket's cache_ids JSONB so
   * the feedback handler can propagate operator votes. Null when
   * persistence failed or the safe fallback was used (we never cache
   * the safe fallback — every fresh ticket gets the same fallback for
   * free without consulting the cache).
   */
  cache_id?: string | null;
}

function buildUserPrompt(
  ticket: SupportTicket,
  pattern: SupportPattern,
): string {
  const truncatedBody = (ticket.body ?? "").slice(0, TICKET_BODY_TRUNCATE);
  const parts: string[] = [];
  parts.push(`Customer subject: ${ticket.title}`);
  parts.push("");
  parts.push("Customer message (truncated):");
  parts.push(truncatedBody);
  if (
    pattern.auto_acknowledge_template &&
    pattern.auto_acknowledge_template.trim().length > 0
  ) {
    parts.push("");
    parts.push("Self-serve steps to base the reply on (rephrase carefully):");
    parts.push(pattern.auto_acknowledge_template);
  }
  parts.push("");
  parts.push(
    "Write the auto-acknowledgement now. Output the email body only.",
  );
  return parts.join("\n");
}

function containsForbiddenPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_OUTPUT_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

/**
 * Generate the auto-ack subject + body. Always returns something safe to
 * send: on AI error, empty content, or forbidden-phrase trip we fall
 * back to SAFE_FALLBACK_BODY rather than refuse to reply. The customer
 * always gets *some* acknowledgement.
 *
 * Subject is always "Re: <ticket.title>" so Outlook + Gmail thread the
 * reply onto the original message even when /messages/{id}/reply is not
 * the send path.
 */
export async function generateAutoAcknowledge(
  ticket: SupportTicket,
  pattern: SupportPattern,
): Promise<AutoAcknowledgeDraft> {
  const subject = `Re: ${ticket.title}`;

  /* Persistent cache lookup. The auto-ack key is per-pattern so two
     tickets matching the same pattern produce the same cached body
     after normalization (names, timestamps, contact info stripped).
     Cache failures fall through to a fresh AI call. */
  let cacheId: string | null = null;
  try {
    const lookup = await lookupCachedResponse({
      feature: "support.auto_ack",
      input: {
        feature: "support.auto_ack",
        title: ticket.title,
        body: ticket.body ?? "",
        pattern_id: pattern.id,
      },
    });
    if (lookup.hit) {
      const candidate = (lookup.cached.content ?? "").trim();
      /* Re-run the safety guards on the cached output. The forbidden-
         phrase list is dynamic; a phrase added after the row was
         cached must still trip the fallback. */
      if (candidate && !containsForbiddenPhrase(candidate)) {
        return { subject, body: candidate, cache_id: lookup.cache_id };
      }
      /* Cached row failed the guard — treat as a miss + write a fresh
         row. The cache row is left in place; the unhelpful counter
         path is the right way to retire it. */
    }
  } catch {
    /* lookup helper logs; defensive double-swallow. */
  }

  const messages: AIMessage[] = [
    { role: "user", content: buildUserPrompt(ticket, pattern) },
  ];

  let body: string;
  let usedSafeFallback = false;
  let aiResponse: Awaited<ReturnType<ReturnType<typeof getAIClient>["complete"]>> | null = null;
  try {
    aiResponse = await getAIClient().complete({
      messages,
      system: SYSTEM_PROMPT,
      max_tokens: MAX_AUTO_ACK_TOKENS,
      /* Low temp: we want a careful, conservative paraphrase, not
         creative writing. */
      temperature: 0.2,
      model_tier: "cheap",
      sensitivity: "public",
      metadata: { feature: "support.auto_ack" },
    });
    const candidate = (aiResponse.content ?? "").trim();
    if (!candidate) {
      body = SAFE_FALLBACK_BODY;
      usedSafeFallback = true;
    } else if (containsForbiddenPhrase(candidate)) {
      body = SAFE_FALLBACK_BODY;
      usedSafeFallback = true;
    } else {
      body = candidate;
    }
  } catch (err) {
    /* AI provider degraded — fall back to safe generic. We still want
       the customer to see "we received your email" within seconds. */
    console.warn(
      "[support/auto-acknowledge] AI complete threw:",
      (err as Error).message,
    );
    body = SAFE_FALLBACK_BODY;
    usedSafeFallback = true;
  }

  /* Only cache real AI output, never the safe fallback. The fallback
     is the same for every ticket — caching it would waste a row and
     mean future operator-helpful votes inflate a row that wasn't
     actually used. */
  if (!usedSafeFallback && aiResponse) {
    try {
      const written = await cacheResponse({
        feature: "support.auto_ack",
        input: {
          feature: "support.auto_ack",
          title: ticket.title,
          body: ticket.body ?? "",
          pattern_id: pattern.id,
        },
        response: { ...aiResponse, content: body },
      });
      cacheId = written.cache_id || null;
    } catch {
      /* swallowed by cacheResponse already; defensive double-catch. */
    }
  }

  return { subject, body, cache_id: cacheId };
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export type SendAutoAcknowledgeResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

function graphReplyUrl(messageId: string): string {
  return `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`;
}

/**
 * Send the auto-ack via Graph `/me/messages/{id}/reply` so the reply
 * lands on the original email's conversationId. Uses the
 * AUTOMATION_POLL_USER_ID service identity (the same one the cron uses
 * for read access on the support@ shared mailbox) so the auto-ack is a
 * service action, not an operator action.
 *
 * Never throws — returns a structured ok/error result so the
 * orchestrator can decide whether to mark the ticket as auto-ack'd.
 */
export async function sendAutoAcknowledge(
  ticketId: string,
  ticket: SupportTicket,
  draft: AutoAcknowledgeDraft,
): Promise<SendAutoAcknowledgeResult> {
  if (!ticket.graph_message_id) {
    return { ok: false, error: "ticket_missing_graph_message_id" };
  }

  /* AUTOMATION_POLL_USER_ID is the service identity for cron-triggered
     mailbox actions; same env var the read-side poller uses. Defaults
     match the existing /api/support/poll route. */
  const serviceUserId =
    process.env.AUTOMATION_POLL_USER_ID ?? "automation-cron";

  const token = await getValidToken(serviceUserId);
  if (!token) {
    return { ok: false, error: "no_token" };
  }

  /* Graph /reply payload. The `comment` carries our auto-ack body; the
     `toRecipients` override ensures the reply lands at the original
     sender even if the inbound message was multi-recipient. We deliver
     a synthetic message id back since /reply returns 202 with no body
     (Graph does not echo the new message id on this endpoint). */
  const payload = {
    comment: draft.body,
    message: {
      toRecipients: ticket.created_by_email
        ? [{ emailAddress: { address: ticket.created_by_email } }]
        : undefined,
    },
  };

  let res: Response;
  try {
    res = await fetch(graphReplyUrl(ticket.graph_message_id), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      ok: false,
      error: `graph_fetch_threw: ${(err as Error).message}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `graph_auth_${res.status}` };
  }
  if (!res.ok && res.status !== 202) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* swallow */
    }
    return {
      ok: false,
      error: `graph_status_${res.status}: ${detail.slice(0, 200)}`,
    };
  }

  /* Synthetic id since Graph /reply returns 202 with no message id.
     Same convention as the manual /api/support/tickets/[id]/send route
     so a future reconciliation pass can backfill the real Graph id from
     the Sent Items folder. */
  const syntheticMessageId = `auto-ack:${ticketId}:${Date.now()}`;
  return { ok: true, messageId: syntheticMessageId };
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                         */
/* ------------------------------------------------------------------ */

export interface ProcessAutoAcknowledgeResult {
  acknowledged: boolean;
  reason?: string;
}

/**
 * End-to-end auto-ack pipeline for one ticket. Loads the ticket, finds
 * the best matching pattern, runs the gate, generates the AI rephrase,
 * sends via Graph, persists the audit trail, fires analytics. Never
 * throws — every error path returns `{ acknowledged: false, reason }`
 * and is logged via obs.recordError.
 *
 * Side effects on success:
 *   - Graph reply sent to the customer
 *   - markTicketAutoAcknowledged updates the 3 ticket columns
 *   - appendTicketReply inserts an outbound row into
 *     instinct_support_ticket_messages so the auto-ack appears in the
 *     ticket thread alongside the inbound email
 *   - support.auto_acknowledged analytics event fires
 *
 * Returns `{ acknowledged: true }` only when the Graph send succeeded
 * AND the audit columns were persisted. Anything earlier returns
 * `{ acknowledged: false, reason }` — the ticket falls through to the
 * regular operator-review flow.
 */
export async function processAutoAcknowledge(
  ticketId: string,
): Promise<ProcessAutoAcknowledgeResult> {
  const start = Date.now();
  const obs = getObsClient();

  let ticket: SupportTicket | null;
  try {
    ticket = await getTicket(ticketId);
  } catch (err) {
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "load_ticket",
      ticket_id: ticketId,
    });
    return { acknowledged: false, reason: "load_ticket_failed" };
  }
  if (!ticket) {
    return { acknowledged: false, reason: "ticket_not_found" };
  }

  /* Idempotency: never auto-ack a ticket twice. The poller can re-run
     against the same ticket if a partial failure leaves the cursor
     un-advanced; a second auto-ack would spam the customer. */
  if (ticket.auto_acknowledged_at) {
    return { acknowledged: false, reason: "already_acknowledged" };
  }

  /* Find the best matching pattern. We reuse the same pattern-library
     matcher the draft pipeline uses so the auto-ack and draft agree on
     which pattern is responsible. */
  let patterns: SupportPattern[] = [];
  try {
    patterns = await listEnabledPatterns();
  } catch (err) {
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "list_patterns",
      ticket_id: ticketId,
    });
    return { acknowledged: false, reason: "list_patterns_failed" };
  }

  const haystack = [
    ticket.title,
    ticket.body,
    ticket.diagnostic_text ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const matched = findMatchingPatterns(haystack, patterns);
  /* Pick the highest-confidence pattern that ALSO has auto-ack
     enabled. findMatchingPatterns already sorts by net feedback; we
     filter for opt-in then take the head. */
  const pattern =
    matched.find(
      (p) =>
        p.auto_acknowledge_enabled === true &&
        typeof p.auto_acknowledge_template === "string" &&
        p.auto_acknowledge_template.trim().length > 0,
    ) ?? null;

  if (!shouldAutoAcknowledge(ticket, pattern)) {
    return { acknowledged: false, reason: "gate_blocked" };
  }
  /* shouldAutoAcknowledge guarantees pattern is non-null when the
     gate passes; the type guard below is for the compiler. */
  if (!pattern) {
    return { acknowledged: false, reason: "gate_blocked" };
  }

  let draft: AutoAcknowledgeDraft;
  try {
    draft = await generateAutoAcknowledge(ticket, pattern);
  } catch (err) {
    /* generateAutoAcknowledge already swallows AI errors and returns
       the safe fallback, but defense-in-depth: if it ever throws we
       still log and exit cleanly. */
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "generate",
      ticket_id: ticketId,
    });
    return { acknowledged: false, reason: "generate_threw" };
  }

  let sendResult: SendAutoAcknowledgeResult;
  try {
    sendResult = await sendAutoAcknowledge(ticketId, ticket, draft);
  } catch (err) {
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "send",
      ticket_id: ticketId,
    });
    return { acknowledged: false, reason: "send_threw" };
  }
  if (!sendResult.ok) {
    obs.recordError(new Error(`auto_ack_send_failed: ${sendResult.error}`), {
      feature: "support.auto_ack",
      stage: "send_result",
      ticket_id: ticketId,
      pattern_id: pattern.id,
    });
    return { acknowledged: false, reason: sendResult.error };
  }

  /* Persist the audit trail. Two writes:
       1. markTicketAutoAcknowledged sets the 3 ticket columns.
       2. appendTicketReply inserts the outbound row into
          instinct_support_ticket_messages so the auto-ack appears in
          the thread alongside the inbound email + future operator reply.

     Both go through writeQuery with expectRows: 1 so a silent miss
     surfaces as a thrown error. We treat a persistence failure here as
     a hard failure of the auto-ack — better to leave the ticket in
     "open" so the operator sees it and replies manually than to claim
     an auto-ack we cannot prove. */
  try {
    await markTicketAutoAcknowledged(ticketId, {
      messageId: sendResult.messageId,
      patternId: pattern.id,
    });
  } catch (err) {
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "mark_acknowledged",
      ticket_id: ticketId,
    });
    return { acknowledged: false, reason: "mark_acknowledged_failed" };
  }

  try {
    await appendTicketReply(ticketId, {
      graph_message_id: sendResult.messageId,
      internet_message_id: null,
      from_email: SUPPORT_FROM,
      body: draft.body,
      received_at: new Date().toISOString(),
      direction: "outbound",
    });
  } catch (err) {
    /* Audit-row failure is not fatal — the ticket columns already
       record the auto-ack. Log and continue so we don't return
       acknowledged:false when the customer already received the
       reply. */
    obs.recordError(err instanceof Error ? err : new Error(String(err)), {
      feature: "support.auto_ack",
      stage: "append_reply",
      ticket_id: ticketId,
    });
  }

  /* Persist the cache row id so a future feedback vote on this ticket
     can propagate to the cache. Best-effort — the auto-ack already
     succeeded; a setTicketCacheIds failure is a learning-loop loss, not
     a customer-facing one. */
  if (draft.cache_id) {
    try {
      await setTicketCacheIds(ticketId, { auto_ack: draft.cache_id });
    } catch (err) {
      obs.recordError(err instanceof Error ? err : new Error(String(err)), {
        feature: "support.auto_ack",
        stage: "set_cache_id",
        ticket_id: ticketId,
      });
    }
  }

  const latency_ms = Date.now() - start;
  try {
    trackEvent(
      "support.auto_acknowledged",
      "automation-cron",
      "system",
      {
        ticket_id: ticketId,
        pattern_id: pattern.id,
        char_count: draft.body.length,
        latency_ms,
      },
    );
  } catch {
    /* analytics best-effort */
  }

  return { acknowledged: true };
}
