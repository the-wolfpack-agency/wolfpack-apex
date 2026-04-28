/**
 * support / inbox-poller — poll the support@thewolfpack.agency shared
 * mailbox and auto-create support tickets from incoming emails.
 *
 * Mirrors `src/lib/automations/inbox-poller.ts` (the porsche-classes
 * poller) but is scoped to the SINGLE support mailbox and is wired into
 * the support feature, not the automations registry.
 *
 * Flow per tick:
 *   1. Resolve a Microsoft Graph access token for the caller (the
 *      operator running "Run now", or the cron service identity). When
 *      no token is available we return a `skipped: 'no_user_connected'`
 *      result so cron health stays green.
 *   2. Load the shared poll cursor (last_received_at) from
 *      instinct_support_poll_state. The cursor is keyed by 'support-inbox'
 *      so every operator/cron caller advances the same cursor.
 *   3. Hit Graph `GET /users/{upn}/mailFolders/inbox/messages` with
 *      $top=50 + $orderby=receivedDateTime desc + ConsistencyLevel:
 *      eventual, $select set to the fields we actually need.
 *   4. For each message strictly NEWER than the cursor:
 *        a. If conversationId already maps to an existing ticket, this
 *           is a customer reply — append to that ticket via
 *           `appendTicketReply` (idempotent on graph_message_id).
 *        b. Otherwise, create a new ticket with audience='client', run
 *           the pattern library, and persist a draft response.
 *   5. Advance the cursor to the newest receivedDateTime we successfully
 *      processed. The cursor does NOT advance when the Graph fetch
 *      itself fails — a transient outage replays cleanly on the next tick.
 *
 * Mailbox routing: when SUPPORT_INBOX_MAILBOX_UPN is set (production
 * default `support@thewolfpack.agency`), we read from `/users/<upn>` —
 * the operator's token must have `Mail.Read.Shared` scope plus an
 * Exchange "Full Access" delegation on the mailbox. When unset (dev
 * convenience), we fall through to `/me`, reading the operator's own
 * inbox.
 */

import { load as loadHtml } from "cheerio";

import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { getValidToken } from "@/lib/microsoft-graph";
import {
  appendTicketReply,
  createTicket,
  findTicketByConversationId,
  listEnabledPatterns,
  setTicketCategory,
  updateTicket,
} from "@/lib/support/repo";
import {
  findMatchingPatterns,
  generateDraftResponse,
} from "@/lib/support/pattern-library";
import { categorizeTicket } from "@/lib/support/categorizer";
import { processAutoAcknowledge } from "@/lib/support/auto-acknowledge";
import { getObsClient } from "@/lib/obs";
import type { CreateTicketRow } from "@/lib/support/repo";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PollResult {
  source: "support-inbox";
  /** UPN we queried (or '/me' when running in dev fallback mode). */
  mailbox: string;
  messages_seen: number;
  tickets_created: number;
  replies_appended: number;
  drafts_generated: number;
  errors: number;
  duration_ms: number;
  /** Set when the poll was a no-op due to a recoverable precondition.
   *  The route maps this to a 200 so cron health stays green. */
  skipped?: "no_valid_token";
}

interface GraphInboxMessage {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: { emailAddress?: { address?: string | null; name?: string | null } };
  toRecipients?: Array<{
    emailAddress?: { address?: string | null; name?: string | null };
  }>;
  ccRecipients?: Array<{
    emailAddress?: { address?: string | null; name?: string | null };
  }>;
  body?: { contentType?: string | null; content?: string | null };
  receivedDateTime?: string | null;
  hasAttachments?: boolean;
  internetMessageId?: string | null;
  conversationId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Mailbox routing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Graph mailbox base for the support poller. Returns
 * `/users/<encoded-upn>` when SUPPORT_INBOX_MAILBOX_UPN is set
 * (production default `support@thewolfpack.agency`), else `/me` for dev
 * convenience. Mirrors `getMailboxBase` in
 * src/lib/automations/inbox-poller.ts so the routing pattern stays
 * consistent across pollers.
 */
export function getSupportMailboxBase(): string {
  const upn = (process.env.SUPPORT_INBOX_MAILBOX_UPN || "").trim();
  return upn ? `/users/${encodeURIComponent(upn)}` : "/me";
}

/** Human-readable mailbox label for logs / analytics. */
export function getSupportMailboxLabel(): string {
  const upn = (process.env.SUPPORT_INBOX_MAILBOX_UPN || "").trim();
  return upn || "/me";
}

/* ------------------------------------------------------------------ */
/* Cursor helpers                                                      */
/* ------------------------------------------------------------------ */

const CURSOR_ID = "support-inbox";

async function loadCursor(): Promise<string | null> {
  try {
    const r = await query<{ last_received_at: string | null }>(
      `SELECT last_received_at::text AS last_received_at
         FROM instinct_support_poll_state
        WHERE id = $1
        LIMIT 1`,
      [CURSOR_ID],
    );
    return r.rows[0]?.last_received_at ?? null;
  } catch (err) {
    /* Defensive — when the migration hasn't run yet (local dev) we
       return null so the poller still attempts the Graph call. The
       writeQuery on save will surface a clear error if the table is
       genuinely missing in production. */
    console.warn(
      "[support/inbox-poller] cursor load failed:",
      (err as Error).message,
    );
    return null;
  }
}

async function saveCursor(receivedAt: string): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_support_poll_state (id, last_received_at, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       last_received_at = EXCLUDED.last_received_at,
       updated_at       = NOW()
     RETURNING id`,
    [CURSOR_ID, receivedAt],
    { expectRows: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* Email body → plain-text helper                                      */
/* ------------------------------------------------------------------ */

/**
 * Convert a Graph message body to plain text for ticket storage.
 *   - If contentType is 'html', strip tags via cheerio (already a
 *     repo-wide dependency).
 *   - Otherwise return the raw content unchanged.
 *   - Fall back to bodyPreview when no body content is available.
 *
 * Exported for tests. Pure function, no I/O.
 */
export function messageBodyToPlainText(msg: GraphInboxMessage): string {
  const ct = (msg.body?.contentType ?? "").toLowerCase();
  const raw = msg.body?.content ?? "";
  if (raw && ct === "html") {
    try {
      const $ = loadHtml(raw);
      /* Strip noise — script/style/head must not contribute text. */
      $("script, style, head, meta, link").remove();
      /* Cheerio's .text() concatenates with NO spacing between block
         elements, so a multi-paragraph email collapses into one wall
         of text (the "Alicia ZulkerProgram Director" symptom). Inject
         newlines before extracting:
           - <br> → single newline
           - <p>, <div>, <li>, <tr>, headings → double newline (paragraph break)
         Then run .text(), then collapse runs of newlines so we don't
         end up with 8+ blank lines from nested divs. */
      $("br").replaceWith("\n");
      $("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, table").each(
        (_, el) => {
          $(el).prepend("\n\n");
          $(el).append("\n\n");
        },
      );
      const text = $("body").text() || $.root().text();
      return text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } catch (err) {
      console.warn(
        "[support/inbox-poller] HTML strip failed:",
        (err as Error).message,
      );
      return raw;
    }
  }
  if (raw) return raw;
  return msg.bodyPreview ?? "";
}

/**
 * Heuristic diagnostic-text extractor: pull anything that looks like a
 * tail-of-message technical block (signature/footer with error codes,
 * URLs, log ids). We isolate the last segment after the first blank
 * line and grep for technical markers. Returns null when nothing
 * obviously diagnostic was found — the AI draft can still see the full
 * body via `body`.
 */
export function extractDiagnosticText(plainText: string): string | null {
  if (!plainText) return null;
  const segments = plainText.split(/\n{2,}/);
  const tail = segments[segments.length - 1] ?? "";
  if (!tail) return null;
  /* Look for technical markers anywhere in the tail. AADSTS error
     codes, http:// URLs, "trace id", "correlation id", or a leading
     stack-frame at(...) line all qualify. Operators can edit the
     diagnostic_text on the ticket detail page if the heuristic
     misfires. */
  if (
    /AADSTS\d{4,6}/i.test(tail) ||
    /trace[-\s_]*id\b/i.test(tail) ||
    /correlation[-\s_]*id\b/i.test(tail) ||
    /https?:\/\/\S+/.test(tail) ||
    /\bat [\w$.]+ \(/.test(tail) ||
    /\b(error|exception|stacktrace)\b/i.test(tail)
  ) {
    return tail.trim().slice(0, 4000);
  }
  return null;
}

/**
 * Convert a Graph inbox message into the shape `createTicket` expects.
 * Pure transformation — exported so tests can drive it without the
 * full Graph fetch.
 */
export function messageToTicket(msg: GraphInboxMessage): CreateTicketRow {
  const plainBody = messageBodyToPlainText(msg);
  const diagnostic = extractDiagnosticText(plainBody);
  const fromAddr = msg.from?.emailAddress?.address ?? "";
  /* Synthetic id namespace makes the source unambiguous in analytics
     and prevents collision with real Instinct user ids. */
  const syntheticId = fromAddr ? `external:${fromAddr.toLowerCase()}` : "external:unknown";
  return {
    title: (msg.subject ?? "(no subject)").slice(0, 500),
    body: plainBody,
    diagnostic_text: diagnostic,
    category: "general",
    severity: "p2",
    audience: "client",
    created_by_user_id: syntheticId,
    created_by_email: fromAddr || null,
    graph_message_id: msg.id,
    graph_internet_message_id: msg.internetMessageId ?? null,
    graph_conversation_id: msg.conversationId ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function pollSupportInbox(args: {
  userId: string;
  userRole: string;
}): Promise<PollResult> {
  const start = Date.now();
  const mailboxLabel = getSupportMailboxLabel();
  const base = getSupportMailboxBase();

  const token = await getValidToken(args.userId);
  if (!token) {
    try {
      trackEvent("support.poll_run", args.userId, args.userRole, {
        source: "support-inbox",
        mailbox: mailboxLabel,
        skipped: "no_valid_token",
        messages_seen: 0,
        tickets_created: 0,
        replies_appended: 0,
        drafts_generated: 0,
        errors: 0,
        duration_ms: Date.now() - start,
      });
    } catch {
      /* analytics best-effort */
    }
    return {
      source: "support-inbox",
      mailbox: mailboxLabel,
      messages_seen: 0,
      tickets_created: 0,
      replies_appended: 0,
      drafts_generated: 0,
      errors: 0,
      duration_ms: Date.now() - start,
      skipped: "no_valid_token",
    };
  }

  const cursor = await loadCursor();

  /* Compose the Graph URL exactly as spec'd: top=50 with the field
     selection the ticket-creation pipeline actually needs.
     ConsistencyLevel: eventual is required when combining $orderby
     with $select on a shared mailbox. */
  const url = new URL(`https://graph.microsoft.com/v1.0${base}/mailFolders/inbox/messages`);
  url.searchParams.set("$top", "50");
  url.searchParams.set(
    "$select",
    "id,subject,bodyPreview,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments,internetMessageId,conversationId",
  );
  url.searchParams.set("$orderby", "receivedDateTime desc");

  let payload: { value?: GraphInboxMessage[] } = {};
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        ConsistencyLevel: "eventual",
      },
    });
    if (res.status === 401 || res.status === 403) {
      try {
        trackEvent("support.poll_run", args.userId, args.userRole, {
          source: "support-inbox",
          mailbox: mailboxLabel,
          skipped: "no_valid_token",
          status: res.status,
          duration_ms: Date.now() - start,
        });
      } catch {
        /* best-effort */
      }
      return {
        source: "support-inbox",
        mailbox: mailboxLabel,
        messages_seen: 0,
        tickets_created: 0,
        replies_appended: 0,
        drafts_generated: 0,
        errors: 0,
        duration_ms: Date.now() - start,
        skipped: "no_valid_token",
      };
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      console.warn(
        `[support/inbox-poller] graph_${res.status}: ${detail.slice(0, 300)}`,
      );
      try {
        trackEvent("support.poll_run", args.userId, args.userRole, {
          source: "support-inbox",
          mailbox: mailboxLabel,
          status: res.status,
          errors: 1,
          duration_ms: Date.now() - start,
        });
      } catch {
        /* best-effort */
      }
      return {
        source: "support-inbox",
        mailbox: mailboxLabel,
        messages_seen: 0,
        tickets_created: 0,
        replies_appended: 0,
        drafts_generated: 0,
        errors: 1,
        duration_ms: Date.now() - start,
      };
    }
    payload = (await res.json()) as { value?: GraphInboxMessage[] };
  } catch (err) {
    console.warn(
      `[support/inbox-poller] fetch threw: ${(err as Error).message}`,
    );
    return {
      source: "support-inbox",
      mailbox: mailboxLabel,
      messages_seen: 0,
      tickets_created: 0,
      replies_appended: 0,
      drafts_generated: 0,
      errors: 1,
      duration_ms: Date.now() - start,
    };
  }

  const items = payload.value ?? [];
  const messagesSeen = items.length;
  let ticketsCreated = 0;
  let repliesAppended = 0;
  let draftsGenerated = 0;
  let errors = 0;
  let newestProcessed: string | null = cursor;

  /* Pre-load the active pattern library ONCE per tick so we don't pay
     a DB roundtrip per message. Best-effort: a pattern-library outage
     downgrades to "no patterns matched" — the AI draft still runs and
     asks the user for clarification (per the SYSTEM_PROMPT fallback
     in pattern-library.ts). */
  let patterns: Awaited<ReturnType<typeof listEnabledPatterns>> = [];
  try {
    patterns = await listEnabledPatterns();
  } catch (err) {
    console.warn(
      "[support/inbox-poller] listEnabledPatterns failed:",
      (err as Error).message,
    );
  }

  for (const msg of items) {
    const rcv = msg.receivedDateTime ?? null;
    /* Strict newer-than-cursor filter. The list is sorted desc but we
       can't exit early on the first old message because Graph
       occasionally returns slightly out-of-order results when receive
       timestamps collide (under the ms granularity). */
    if (cursor && rcv && rcv <= cursor) continue;
    if (!msg.id) {
      errors += 1;
      continue;
    }

    try {
      /* Conversation-id linking: if a ticket already exists for this
         thread, append the inbound message and skip ticket-create.
         This is the path that handles "customer replied to our
         support@ reply" — the customer's mail client carries the same
         conversationId across the thread. */
      const conv = msg.conversationId ?? null;
      const existing = conv
        ? await findTicketByConversationId(conv)
        : null;
      if (existing) {
        const plain = messageBodyToPlainText(msg);
        await appendTicketReply(existing.id, {
          graph_message_id: msg.id,
          internet_message_id: msg.internetMessageId ?? null,
          from_email: msg.from?.emailAddress?.address ?? null,
          body: plain,
          received_at: rcv,
          direction: "inbound",
        });
        repliesAppended += 1;
        if (rcv && (!newestProcessed || rcv > newestProcessed)) {
          newestProcessed = rcv;
        }
        continue;
      }

      /* New ticket from this email. createTicket already handles the
         triple-write side-effects (Qdrant + Neo4j) so the
         data/learning integration is preserved automatically. */
      const ticketInput = messageToTicket(msg);
      let ticket = await createTicket(ticketInput);
      ticketsCreated += 1;

      /* AI auto-categorization for the email-ingest path. Email
         tickets default to category='general' from messageToTicket,
         so we always run the classifier on them. Defensive: any
         failure (AI down, DB hiccup) is logged and we continue with
         the default category; never block ticket creation on this. */
      try {
        const catResult = await categorizeTicket({
          title: ticket.title,
          body: ticket.body,
          diagnostic_text: ticket.diagnostic_text ?? undefined,
        });
        await setTicketCategory(
          ticket.id,
          catResult.category,
          "ai",
          catResult.confidence,
        );
        /* Mirror the new category into the in-memory ticket so the
           draft generator (which reads ticket.category for prompt
           context) sees the up-to-date value. */
        ticket = {
          ...ticket,
          category: catResult.category,
          category_source: "ai",
          category_confidence: catResult.confidence,
        };
        try {
          trackEvent(
            "support.categorized",
            args.userId,
            args.userRole,
            {
              ticket_id: ticket.id,
              category: catResult.category,
              confidence: catResult.confidence,
              source: "ai",
            },
          );
        } catch {
          /* analytics best-effort */
        }
      } catch (err) {
        console.warn(
          "[support/inbox-poller] auto-categorize failed:",
          (err as Error).message,
        );
      }

      /* Draft generation: pattern-match the body+diagnostic, then ask
         Claude for a draft. Both helpers fail gracefully — a missing
         ANTHROPIC_API_KEY downgrades to ok:false and we just leave
         the draft empty. */
      const haystack = [ticket.title, ticket.body, ticket.diagnostic_text ?? ""]
        .filter(Boolean)
        .join("\n");
      const matched = findMatchingPatterns(haystack, patterns);
      const matchedIds = matched.map((p) => p.id);
      let draftBody: string | null = null;
      try {
        const outcome = await generateDraftResponse({
          ticket,
          matchingPatterns: matched,
        });
        if (outcome.ok) {
          draftBody = outcome.draft;
        }
      } catch (err) {
        console.warn(
          "[support/inbox-poller] generateDraftResponse threw:",
          (err as Error).message,
        );
      }

      /* Persist the draft + matched pattern ids so the operator-facing
         ticket page renders the AI draft without an extra roundtrip.
         status moves to 'drafted' on success — same lifecycle as the
         manual create+draft path. */
      const patch: Record<string, unknown> = {
        draft_pattern_ids: matchedIds,
      };
      if (draftBody) {
        patch.draft_response = draftBody;
        patch.draft_generated_at = new Date().toISOString();
        patch.status = "drafted";
        draftsGenerated += 1;
      }
      try {
        await updateTicket(ticket.id, patch);
      } catch (err) {
        console.warn(
          "[support/inbox-poller] draft persist failed:",
          (err as Error).message,
        );
      }

      /* Fire-and-forget auto-acknowledgement. The whole point of the
         auto-ack is that it runs WITHIN 30 seconds of the email
         landing — much faster than the 5-minute draft+review cron —
         so we deliberately do NOT await it here. Auto-ack failure must
         NEVER block ticket creation or cursor advance.
         processAutoAcknowledge already returns a structured result and
         logs via obs.recordError, but we wrap one more try/catch here
         as belt-and-braces against any unhandled promise rejection. */
      void processAutoAcknowledge(ticket.id).catch((err) => {
        try {
          getObsClient().recordError(
            err instanceof Error ? err : new Error(String(err)),
            {
              feature: "support.auto_ack",
              stage: "poller_dispatch",
              ticket_id: ticket.id,
            },
          );
        } catch {
          /* obs failures must never escape the poller */
        }
      });

      if (rcv && (!newestProcessed || rcv > newestProcessed)) {
        newestProcessed = rcv;
      }
    } catch (err) {
      errors += 1;
      console.warn(
        `[support/inbox-poller] message ${msg.id} failed: ${(err as Error).message}`,
      );
    }
  }

  /* Advance cursor only when we processed at least one new message
     and the timestamp moved forward. A poll with zero new messages
     must NOT touch the cursor (would create a window where late-
     arriving messages with timestamps near the cursor get skipped). */
  if (newestProcessed && newestProcessed !== cursor) {
    try {
      await saveCursor(newestProcessed);
    } catch (err) {
      errors += 1;
      console.warn(
        "[support/inbox-poller] cursor save failed:",
        (err as Error).message,
      );
    }
  }

  /* Self-healing retry pass for tickets whose first auto-ack attempt
     failed (transient Graph 5xx, ErrorMailboxMoveInProgress, token
     blip). We re-run processAutoAcknowledge on every recent client
     ticket that still has no auto_acknowledged_at. processAutoAcknowledge
     already short-circuits on `already_acknowledged` so this is safe.
     We cap at 10/poll and 24h-old to bound work. */
  let autoAckRetried = 0;
  let autoAckRecovered = 0;
  try {
    const stuckResult = await query<{ id: string }>(
      `SELECT id FROM instinct_support_tickets
        WHERE audience = 'client'
          AND graph_message_id IS NOT NULL
          AND auto_acknowledged_at IS NULL
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at ASC
        LIMIT 10`,
    );
    for (const row of stuckResult.rows) {
      autoAckRetried += 1;
      try {
        const r = await processAutoAcknowledge(row.id);
        if (r.acknowledged) autoAckRecovered += 1;
      } catch (err) {
        getObsClient().recordError(
          err instanceof Error ? err : new Error(String(err)),
          {
            feature: "support.auto_ack",
            stage: "retry_pass",
            ticket_id: row.id,
          },
        );
      }
    }
  } catch (err) {
    console.warn(
      "[support/inbox-poller] auto-ack retry pass failed:",
      (err as Error).message,
    );
  }

  const duration_ms = Date.now() - start;
  try {
    trackEvent("support.poll_run", args.userId, args.userRole, {
      source: "support-inbox",
      mailbox: mailboxLabel,
      messages_seen: messagesSeen,
      tickets_created: ticketsCreated,
      replies_appended: repliesAppended,
      drafts_generated: draftsGenerated,
      auto_ack_retried: autoAckRetried,
      auto_ack_recovered: autoAckRecovered,
      errors,
      duration_ms,
    });
  } catch {
    /* best-effort */
  }

  return {
    source: "support-inbox",
    mailbox: mailboxLabel,
    messages_seen: messagesSeen,
    tickets_created: ticketsCreated,
    replies_appended: repliesAppended,
    drafts_generated: draftsGenerated,
    errors,
    duration_ms,
  };
}
