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

export function messageMatchesAutomation(
  message: GraphMailMessage,
  automation: AutomationDefinition,
): boolean {
  const filters = automation.inbox_filters;
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
  const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,contentBytes`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) {
    throw new GraphClientError(
      res.status,
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "scope_missing"
          : res.status === 404
            ? "not_found"
            : "graph_error",
      `attachments fetch failed: ${res.status}`,
    );
  }
  const body = (await res.json()) as { value?: GraphAttachment[] };
  const out: Array<{ name: string; contentType: string; bytes: Buffer }> = [];
  for (const att of body.value ?? []) {
    if (att["@odata.type"] && !/fileAttachment/i.test(att["@odata.type"])) {
      continue; // Skip reference / itemAttachment — we don't fetch those.
    }
    if (!att.contentBytes) continue;
    out.push({
      name: att.name,
      contentType: att.contentType,
      bytes: Buffer.from(att.contentBytes, "base64"),
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
  if (
    "porsche_xlsx" in automation.parsers &&
    (lower.endsWith(".xlsx") ||
      lower.endsWith(".csv") ||
      ct.includes("spreadsheet") ||
      ct.includes("text/csv"))
  ) {
    return "porsche_xlsx";
  }
  return null;
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
    trackEvent("automation.poll_skipped", {
      automation_id: args.automationId,
      reason: "no_user_connected",
      user_id: args.userId,
    }).catch(() => {});
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

  for (const msg of items) {
    if (msg["@removed"]) continue; // Mailbox tombstones — not relevant.
    if (!messageMatchesAutomation(msg, automation)) continue;
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
