/**
 * automations / inbox-poller — Microsoft Graph mail polling for the
 * automations surface.
 *
 * Calls `listMailDelta` on the configured user's inbox, filters returned
 * messages by the automation's `inbox_filters`, downloads each matching
 * message's attachment bytes, and dispatches every artifact to
 * `ingestArtifact`.
 *
 * Cursor: persisted per (automation_id, user_id) in the
 * `instinct_automation_porsche_poll_state` table. On every successful
 * tick we save the new deltaLink, so subsequent polls only see fresh
 * messages.
 *
 * Resumable + idempotent:
 *   - if the cursor is missing we start at "now - 7 days" (delta returns
 *     a fresh deltaLink alongside historical messages).
 *   - if `ingestArtifact` no-ops for an already-seen
 *     (source_message_id, content_sha256), we still advance the cursor.
 *   - any error during ingest of a single message is caught and
 *     surfaces as an exception row; the cursor still advances so a
 *     poison message doesn't block forever — manual replay is the
 *     escape hatch (re-run with cursor reset).
 */

import { listMailDelta, type GraphMailMessage, GraphClientError } from "@/lib/ms-graph/client";
import { getValidToken } from "@/lib/microsoft-graph";
import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { getAutomation } from "./registry";
import { ingestArtifact, type IngestResult } from "./porsche-classes/ingest";
import { ingestMeetingMessage } from "./meeting-insights/ingest";
import { runAnalyzer } from "./meeting-insights/run-analyzer";
import type { AutomationDefinition, AutomationId, AutomationSourceType } from "./types";

/* ------------------------------------------------------------------ */
/* Cursor helpers                                                      */
/* ------------------------------------------------------------------ */

async function loadDeltaLink(
  automationId: AutomationId,
  userId: string,
): Promise<string | null> {
  const r = await query<{ delta_link: string | null }>(
    `SELECT delta_link
       FROM instinct_automation_porsche_poll_state
      WHERE automation_id = $1 AND user_id = $2`,
    [automationId, userId],
  );
  return r.rows[0]?.delta_link ?? null;
}

async function saveDeltaLink(
  automationId: AutomationId,
  userId: string,
  deltaLink: string | null,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_automation_porsche_poll_state
       (automation_id, user_id, delta_link, last_polled_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (automation_id, user_id) DO UPDATE SET
       delta_link     = EXCLUDED.delta_link,
       last_polled_at = NOW(),
       updated_at     = NOW()
     RETURNING automation_id`,
    [automationId, userId, deltaLink],
    { expectRows: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* Filter — does a message match this automation's inbox filters?      */
/* ------------------------------------------------------------------ */

/**
 * Resolve the active filter set for an automation. Awaits
 * `loadInboxFilters()` when present (used by meeting-insights so admin
 * changes to feeds take effect without a redeploy) and falls back to
 * the static `inbox_filters` field on any error / when not provided.
 *
 * Exported for tests. The poller calls this ONCE per tick before the
 * delta-fetch loop so we don't pay the cost per message.
 */
export async function resolveActiveInboxFilters(
  automation: AutomationDefinition,
): Promise<{ sender_match?: string[]; subject_match?: string[] }> {
  if (typeof automation.loadInboxFilters === "function") {
    try {
      return await automation.loadInboxFilters();
    } catch (err) {
      console.warn(
        `[automations/inbox-poller] loadInboxFilters threw for ${automation.id}: ${(err as Error).message}; falling back to static filters`,
      );
    }
  }
  return automation.inbox_filters;
}

export function messageMatchesAutomation(
  message: GraphMailMessage,
  automation: AutomationDefinition,
  activeFilters?: { sender_match?: string[]; subject_match?: string[] },
): boolean {
  const filters = activeFilters ?? automation.inbox_filters;
  const senderMatch = filters.sender_match ?? [];
  const subjectMatch = filters.subject_match ?? [];

  if (senderMatch.length > 0) {
    const fromAddr = (message.from?.emailAddress?.address ?? "").toLowerCase();
    if (!senderMatch.some((s) => fromAddr.includes(s.toLowerCase()))) {
      return false;
    }
  }
  if (subjectMatch.length > 0) {
    const subj = (message.subject ?? "").toLowerCase();
    if (!subjectMatch.some((s) => subj.includes(s.toLowerCase()))) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Attachment fetcher                                                  */
/* ------------------------------------------------------------------ */

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** Base64 file content for fileAttachment items. */
  contentBytes?: string | null;
  "@odata.type"?: string;
}

/**
 * Fetch every fileAttachment (skip referenceAttachment / itemAttachment)
 * for a Graph message. Uses the access token directly — Graph attachments
 * are NOT delta-feed shaped, so we can't reuse the delta drainer.
 */
async function fetchAttachments(
  userId: string,
  messageId: string,
): Promise<Array<{ name: string; contentType: string; bytes: Buffer }>> {
  const token = await getValidToken(userId);
  if (!token) {
    throw new GraphClientError(
      401,
      "no_token",
      `inbox-poller: no token for user ${userId}`,
    );
  }
  /* IMPORTANT: do NOT include `contentBytes` in the LIST $select. Graph
     drops items from the list response when contentBytes is requested
     there (it's a large property only resolvable on individual
     /attachments/{id} fetches). The earlier shape silently returned []
     for messages whose only attachment was a real fileAttachment. We
     now list the attachments first (cheap), then fetch each
     fileAttachment individually with bytes. */
  const listUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!listRes.ok) {
    throw new GraphClientError(
      listRes.status,
      listRes.status === 401
        ? "unauthorized"
        : listRes.status === 403
          ? "scope_missing"
          : listRes.status === 404
            ? "not_found"
            : "graph_error",
      `attachments list failed: ${listRes.status}`,
    );
  }
  const list = (await listRes.json()) as { value?: GraphAttachment[] };
  const out: Array<{ name: string; contentType: string; bytes: Buffer }> = [];
  for (const att of list.value ?? []) {
    if (att["@odata.type"] && !/fileAttachment/i.test(att["@odata.type"])) {
      continue; // Skip reference / itemAttachment — we can't fetch bytes for those.
    }
    /* Per-attachment fetch to actually get contentBytes. */
    const oneUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}`;
    const oneRes = await fetch(oneUrl, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!oneRes.ok) continue;
    const one = (await oneRes.json()) as GraphAttachment;
    if (!one.contentBytes) continue;
    out.push({
      name: one.name,
      contentType: one.contentType,
      bytes: Buffer.from(one.contentBytes, "base64"),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* source_type detector — bytes + filename → AutomationSourceType      */
/* ------------------------------------------------------------------ */

/**
 * Today the only Stream-A parser is `porsche_xlsx`, so any *.xlsx /
 * *.csv attachment from the Porsche academy mailbox is the BA101/102
 * report. Stream B's parsers will register additional source_types
 * (cognito_*, survey) and update this dispatch.
 */
export function detectSourceType(
  filename: string,
  contentType: string,
  automation: AutomationDefinition,
): AutomationSourceType | null {
  const lower = filename.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  const isSpreadsheet =
    lower.endsWith(".xlsx") ||
    lower.endsWith(".csv") ||
    ct.includes("spreadsheet") ||
    ct.includes("text/csv");

  /* Survey export wins over the generic porsche-daily roster when the
     filename advertises itself ("Survey Data PCBA …" or starts with
     a course code immediately followed by a hotel name). The two
     exports look identical to MIME type inspection — only the
     filename disambiguates them. */
  if (
    "survey" in automation.parsers &&
    isSpreadsheet &&
    (/(^|[^a-z])survey[\s_]*data/i.test(filename) ||
      /(^|[^a-z])(101|102)\b.*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(
        filename,
      ))
  ) {
    return "survey";
  }
  if ("porsche_xlsx" in automation.parsers && isSpreadsheet) {
    return "porsche_xlsx";
  }
  return null;
}

/**
 * Per-automation: does this automation ingest at the MESSAGE level
 * (one row per email regardless of attachments, body extraction handled
 * by Stream B parsers) rather than per-attachment? meeting-insights is
 * the message-level case; porsche-classes is per-attachment.
 *
 * Exported so the poller can branch without a hard-coded id check.
 */
export function isMessageLevelIngest(automation: AutomationDefinition): boolean {
  return "email" in automation.parsers;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export interface PollResult {
  automation_id: AutomationId;
  messages_seen: number;
  messages_matched: number;
  artifacts_ingested: number;
  artifacts_duplicate: number;
  artifacts_quarantined: number;
  errors: number;
  duration_ms: number;
  /** Set when the poll was a no-op due to a recoverable precondition
      (e.g. no user has connected their mailbox yet). The route maps
      this to a 200 so cron health stays green. */
  skipped?: "no_user_connected" | "no_valid_token";
}

export async function pollInbox(args: {
  automationId: AutomationId;
  userId: string;
  userRole: string;
}): Promise<PollResult> {
  const start = Date.now();
  const automation = getAutomation(args.automationId);
  if (!automation) {
    throw new Error(`unknown automation: ${args.automationId}`);
  }

  /* Soft-fail when the poller has no token to use. This is the normal
     bootstrap state — the cron starts running before any user has
     signed in. We return a structured skip so the route stays 200 and
     cron health doesn't redline; once a real user connects, the next
     tick proceeds normally. */
  const preToken = await getValidToken(args.userId);
  if (!preToken) {
    try {
      trackEvent(
        "automations.poll_skipped",
        args.userId,
        args.userRole,
        { automation_id: args.automationId, reason: "no_user_connected" },
      );
    } catch {
      /* analytics is best-effort; never throw out of poll */
    }
    return {
      automation_id: args.automationId,
      messages_seen: 0,
      messages_matched: 0,
      artifacts_ingested: 0,
      artifacts_duplicate: 0,
      artifacts_quarantined: 0,
      errors: 0,
      duration_ms: Date.now() - start,
      skipped: "no_user_connected",
    };
  }

  const cursor = await loadDeltaLink(args.automationId, args.userId);
  let items: Awaited<ReturnType<typeof listMailDelta>>["items"];
  let nextDeltaLink: string | undefined;
  try {
    ({ items, nextDeltaLink } = await listMailDelta(args.userId, cursor ?? undefined));
  } catch (err) {
    if (err instanceof GraphClientError && err.code === "no_token") {
      // Token expired between pre-check and the delta call. Treat as skip.
      return {
        automation_id: args.automationId,
        messages_seen: 0,
        messages_matched: 0,
        artifacts_ingested: 0,
        artifacts_duplicate: 0,
        artifacts_quarantined: 0,
        errors: 0,
        duration_ms: Date.now() - start,
        skipped: "no_valid_token",
      };
    }
    throw err;
  }

  const messagesSeen = items.length;
  let messagesMatched = 0;
  let artifactsIngested = 0;
  let artifactsDuplicate = 0;
  let artifactsQuarantined = 0;
  let errors = 0;

  // Resolve the active filter set ONCE per tick (loadInboxFilters is the
  // dynamic path used by meeting-insights; porsche-classes uses the
  // static `inbox_filters` field). Single resolution avoids paying per
  // message for what is effectively a global config read.
  const activeFilters = await resolveActiveInboxFilters(automation);
  const messageLevel = isMessageLevelIngest(automation);

  for (const msg of items) {
    if (msg["@removed"]) continue; // Mailbox tombstones — not relevant.
    if (!messageMatchesAutomation(msg, automation, activeFilters)) continue;
    messagesMatched += 1;

    let attachments: Awaited<ReturnType<typeof fetchAttachments>>;
    try {
      attachments = await fetchAttachments(args.userId, msg.id);
    } catch (err) {
      errors += 1;
      console.warn(
        `[automations/inbox-poller] attachment fetch failed for ${msg.id}: ${(err as Error).message}`,
      );
      continue;
    }

    if (messageLevel) {
      // Message-level ingest path (meeting-insights): one row per email
      // regardless of attachments. The orchestrator owns body parsing +
      // attachment extraction internally.
      try {
        // Graph mail-message extras live behind the [k: string]: unknown
        // index signature; cast through a narrow shape to extract them.
        const ext = msg as unknown as {
          ccRecipients?: Array<{ emailAddress?: { address?: string | null } }>;
          body?: { contentType?: string | null; content?: string | null };
        };
        const ccRecipients = ext.ccRecipients ?? [];
        const bodyHtml =
          ext.body?.contentType === "html" ? (ext.body?.content ?? null) : null;
        const result = await ingestMeetingMessage({
          automation,
          source_message_id: msg.id,
          received_at: msg.receivedDateTime ?? new Date().toISOString(),
          subject: msg.subject ?? "",
          from_address: msg.from?.emailAddress?.address ?? "",
          from_name: msg.from?.emailAddress?.name ?? null,
          to_addresses: (msg.toRecipients ?? [])
            .map((r) => r.emailAddress?.address)
            .filter((s): s is string => typeof s === "string"),
          cc_addresses: ccRecipients
            .map((r) => r.emailAddress?.address)
            .filter((s): s is string => typeof s === "string"),
          // Raw bytes: we don't get the .eml from delta. Serialize the
          // Graph envelope as a stable representation so the artifact
          // hash is stable across replays.
          raw_bytes: Buffer.from(JSON.stringify(msg), "utf8"),
          mime: "message/rfc822",
          body_html: bodyHtml,
          body_preview: msg.bodyPreview ?? null,
          attachments,
          user_id: args.userId,
          user_role: args.userRole,
        });
        if (result.was_duplicate) artifactsDuplicate += 1;
        else if (result.parse_status === "processed") artifactsIngested += 1;
        else if (result.parse_status === "error_quarantined") artifactsQuarantined += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          `[automations/inbox-poller] meeting ingest failed for ${msg.id}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    for (const att of attachments) {
      const sourceType = detectSourceType(att.name, att.contentType, automation);
      if (!sourceType) continue; // Not an attachment we know how to parse.

      try {
        const result: IngestResult = await ingestArtifact({
          automation,
          source_type: sourceType,
          source_message_id: msg.id,
          received_at: msg.receivedDateTime ?? new Date().toISOString(),
          bytes: att.bytes,
          hint: att.name,
          mime: att.contentType || "application/octet-stream",
          user_id: args.userId,
          user_role: args.userRole,
        });
        if (result.was_duplicate) artifactsDuplicate += 1;
        else if (result.parse_status === "processed") artifactsIngested += 1;
        else if (result.parse_status === "error_quarantined") artifactsQuarantined += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          `[automations/inbox-poller] ingest failed for ${msg.id}/${att.name}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (nextDeltaLink) {
    await saveDeltaLink(args.automationId, args.userId, nextDeltaLink);
  }

  const duration_ms = Date.now() - start;
  trackEvent("automations.poll_run", args.userId, args.userRole, {
    automation_id: args.automationId,
    messages_seen: messagesSeen,
    messages_matched: messagesMatched,
    artifacts_ingested: artifactsIngested,
    artifacts_quarantined: artifactsQuarantined,
    duration_ms,
  });

  return {
    automation_id: args.automationId,
    messages_seen: messagesSeen,
    messages_matched: messagesMatched,
    artifacts_ingested: artifactsIngested,
    artifacts_duplicate: artifactsDuplicate,
    artifacts_quarantined: artifactsQuarantined,
    errors,
    duration_ms,
  };
}

/* ------------------------------------------------------------------ */
/* Historical $search-based scan                                       */
/*                                                                     */
/* The delta-feed cursor is shared across every meeting-insights feed  */
/* because the underlying Graph mailbox is one stream. That makes      */
/* "Run now" on a brand-new feed return 0 — the cursor is already      */
/* past the historical messages this feed wants. This entry point      */
/* runs a Graph $search using the feed's own filters, ingests every    */
/* match, and never touches the delta cursor (so cron continues to     */
/* drive forward incrementally for all feeds).                         */
/* ------------------------------------------------------------------ */

interface HistoricalScanArgs {
  automationId: AutomationId;
  userId: string;
  userRole: string;
  /** Filters to scope the $search — typically the feed's own filters. */
  filters: { sender_match?: string[]; subject_match?: string[] };
  /** Hard cap on messages pulled. Defaults to 50. */
  limit?: number;
  /** Pin every ingested message to this feed instead of letting the
   *  first-match-wins router pick. Used by Run-now from a feed page so
   *  the click ingests into THAT feed, not the oldest matching one. */
  pinnedFeed?: { id: string; slug: string };
}

const kqlValue = (s: string) =>
  /[\s\-]/.test(s) ? `'${s.replace(/'/g, "")}'` : s;

function buildSearchClause(filters: HistoricalScanArgs["filters"]): string {
  const senders = (filters.sender_match ?? [])
    .map((s) => `from:${kqlValue(s)}`)
    .join(" OR ");
  const subjects = (filters.subject_match ?? [])
    .map((s) => `subject:${kqlValue(s)}`)
    .join(" OR ");
  if (senders && subjects) return `(${senders}) AND (${subjects})`;
  return senders || subjects;
}

export async function pollInboxHistorical(args: HistoricalScanArgs): Promise<PollResult> {
  const start = Date.now();
  const automation = getAutomation(args.automationId);
  if (!automation) {
    throw new Error(`unknown automation: ${args.automationId}`);
  }
  const limit = Math.min(args.limit ?? 50, 100);

  const token = await getValidToken(args.userId);
  if (!token) {
    return {
      automation_id: args.automationId,
      messages_seen: 0,
      messages_matched: 0,
      artifacts_ingested: 0,
      artifacts_duplicate: 0,
      artifacts_quarantined: 0,
      errors: 0,
      duration_ms: Date.now() - start,
      skipped: "no_user_connected",
    };
  }

  const searchClause = buildSearchClause(args.filters);
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$top", String(limit));
  url.searchParams.set(
    "$select",
    "id,subject,bodyPreview,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments",
  );
  if (searchClause) {
    url.searchParams.set("$search", `"${searchClause}"`);
  } else {
    url.searchParams.set("$orderby", "receivedDateTime desc");
  }

  let items: GraphMailMessage[] = [];
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        ConsistencyLevel: "eventual",
      },
    });
    if (res.status === 401) {
      return {
        automation_id: args.automationId,
        messages_seen: 0,
        messages_matched: 0,
        artifacts_ingested: 0,
        artifacts_duplicate: 0,
        artifacts_quarantined: 0,
        errors: 0,
        duration_ms: Date.now() - start,
        skipped: "no_valid_token",
      };
    }
    if (!res.ok) {
      console.warn(
        `[automations/inbox-poller] historical $search failed: graph_${res.status}`,
      );
      return {
        automation_id: args.automationId,
        messages_seen: 0,
        messages_matched: 0,
        artifacts_ingested: 0,
        artifacts_duplicate: 0,
        artifacts_quarantined: 0,
        errors: 1,
        duration_ms: Date.now() - start,
      };
    }
    const body = (await res.json()) as { value?: GraphMailMessage[] };
    items = body.value ?? [];
  } catch (err) {
    console.warn(
      `[automations/inbox-poller] historical $search threw: ${(err as Error).message}`,
    );
    return {
      automation_id: args.automationId,
      messages_seen: 0,
      messages_matched: 0,
      artifacts_ingested: 0,
      artifacts_duplicate: 0,
      artifacts_quarantined: 0,
      errors: 1,
      duration_ms: Date.now() - start,
    };
  }

  const messagesSeen = items.length;
  let messagesMatched = 0;
  let artifactsIngested = 0;
  let artifactsDuplicate = 0;
  let artifactsQuarantined = 0;
  let errors = 0;

  /* Belt-and-suspenders: Graph's $search is approximate, so re-apply the
     typed substring filters locally. */
  const localFilters = {
    sender_match: args.filters.sender_match ?? [],
    subject_match: args.filters.subject_match ?? [],
  };

  const messageLevel = isMessageLevelIngest(automation);

  for (const msg of items) {
    if (msg["@removed"]) continue;
    if (!messageMatchesAutomation(msg, automation, localFilters)) continue;
    messagesMatched += 1;

    let attachments: Awaited<ReturnType<typeof fetchAttachments>> = [];
    if (msg.hasAttachments) {
      try {
        attachments = await fetchAttachments(args.userId, msg.id);
      } catch (err) {
        errors += 1;
        console.warn(
          `[automations/inbox-poller] attachment fetch failed for ${msg.id}: ${(err as Error).message}`,
        );
        continue;
      }
    }

    if (messageLevel) {
      try {
        /* Graph's /messages?$search response returns a list shape that
           omits the `body` payload to keep the response small. Do an
           explicit per-message GET to retrieve the html/text body —
           one extra round-trip but it's the only way to get the real
           content. The bodyPreview from the list call is at most ~255
           chars. */
        let bodyHtml: string | null = null;
        let bodyText: string | null = null;
        try {
          const detailUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msg.id)}?$select=body,ccRecipients`;
          const detailRes = await fetch(detailUrl, {
            headers: { Authorization: `Bearer ${token.accessToken}` },
          });
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as {
              body?: { contentType?: string | null; content?: string | null };
              ccRecipients?: Array<{ emailAddress?: { address?: string | null } }>;
            };
            if (detail.body?.contentType?.toLowerCase() === "html") {
              bodyHtml = detail.body?.content ?? null;
            } else if (detail.body?.content) {
              bodyText = detail.body.content;
            }
            (msg as unknown as { ccRecipients?: unknown }).ccRecipients =
              detail.ccRecipients ?? [];
          }
        } catch (err) {
          console.warn(
            `[automations/inbox-poller] body fetch failed for ${msg.id}: ${(err as Error).message}`,
          );
        }
        const ext = msg as unknown as {
          ccRecipients?: Array<{ emailAddress?: { address?: string | null } }>;
        };
        const ccRecipients = ext.ccRecipients ?? [];
        const result = await ingestMeetingMessage({
          automation,
          source_message_id: msg.id,
          received_at: msg.receivedDateTime ?? new Date().toISOString(),
          subject: msg.subject ?? "",
          from_address: msg.from?.emailAddress?.address ?? "",
          from_name: msg.from?.emailAddress?.name ?? null,
          to_addresses: (msg.toRecipients ?? [])
            .map((r) => r.emailAddress?.address)
            .filter((s): s is string => typeof s === "string"),
          cc_addresses: ccRecipients
            .map((r) => r.emailAddress?.address)
            .filter((s): s is string => typeof s === "string"),
          raw_bytes: Buffer.from(JSON.stringify(msg), "utf8"),
          mime: "message/rfc822",
          body_html: bodyHtml,
          body_preview: bodyText ?? msg.bodyPreview ?? null,
          attachments,
          user_id: args.userId,
          user_role: args.userRole,
          pinned_feed: args.pinnedFeed,
        });
        if (result.was_duplicate) artifactsDuplicate += 1;
        else if (result.parse_status === "processed") artifactsIngested += 1;
        else if (result.parse_status === "error_quarantined") artifactsQuarantined += 1;

        /* Run-now is a user-triggered, foreground action — they want
           insights immediately, not "next analyzer cron tick". The
           default fire-and-forget analyzer in ingestMeetingMessage is
           unreliable in serverless (process can be killed when the
           response returns). Await it inline here so the response
           reflects the actual outcome.

           Skip on duplicates: the analysis already exists, no work to
           redo. Skip on quarantine: the message wasn't routed, there's
           no message_id to analyze. */
        if (
          result.parse_status === "processed" &&
          result.feed_id &&
          result.message_id
        ) {
          /* Always run on Run-now, including duplicates: an earlier
             ingest may have produced an empty body_text (parser-shape
             bug), and the conflict-handler now backfills it on re-
             poll. Analyzer is idempotent on (message_id,
             analyzer_version), so re-runs against unchanged content
             cost a Haiku call but converge to the same record. */
          try {
            await runAnalyzer({
              feed_id: result.feed_id,
              message_id: result.message_id,
            });
          } catch (err) {
            console.warn(
              `[automations/inbox-poller] inline analyzer failed for ${msg.id}: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        errors += 1;
        console.warn(
          `[automations/inbox-poller] meeting ingest failed for ${msg.id}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    for (const att of attachments) {
      const sourceType = detectSourceType(att.name, att.contentType, automation);
      if (!sourceType) continue;
      try {
        const result: IngestResult = await ingestArtifact({
          automation,
          source_type: sourceType,
          source_message_id: msg.id,
          received_at: msg.receivedDateTime ?? new Date().toISOString(),
          bytes: att.bytes,
          hint: att.name,
          mime: att.contentType || "application/octet-stream",
          user_id: args.userId,
          user_role: args.userRole,
        });
        if (result.was_duplicate) artifactsDuplicate += 1;
        else if (result.parse_status === "processed") artifactsIngested += 1;
        else if (result.parse_status === "error_quarantined") artifactsQuarantined += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          `[automations/inbox-poller] historical ingest failed for ${msg.id}/${att.name}: ${(err as Error).message}`,
        );
      }
    }
  }

  const duration_ms = Date.now() - start;
  trackEvent("automations.poll_historical", args.userId, args.userRole, {
    automation_id: args.automationId,
    messages_seen: messagesSeen,
    messages_matched: messagesMatched,
    artifacts_ingested: artifactsIngested,
    artifacts_quarantined: artifactsQuarantined,
    duration_ms,
  });

  return {
    automation_id: args.automationId,
    messages_seen: messagesSeen,
    messages_matched: messagesMatched,
    artifacts_ingested: artifactsIngested,
    artifacts_duplicate: artifactsDuplicate,
    artifacts_quarantined: artifactsQuarantined,
    errors,
    duration_ms,
  };
}
