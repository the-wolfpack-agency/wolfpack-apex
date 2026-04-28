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
/* Mailbox routing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Graph mailbox base for the inbox poller. Returns `/me` by default —
 * the operator's own inbox, no extra scope needed. When the env var
 * `AUTOMATION_POLL_MAILBOX_UPN` is set (e.g.
 * `pcna-automation@thewolfpack.agency`), routes through
 * `/users/<encoded-upn>` so the cron reads from a shared mailbox that
 * the operator has been granted Full Access to in Exchange admin.
 *
 * The shared-mailbox path additionally requires `Mail.Read.Shared` in
 * MS_SCOPES (already declared in microsoft-graph.ts) and an Exchange
 * "Full Access" delegation on the target mailbox. With both in place,
 * the operator's existing delegated token can read shared messages
 * without changing the Microsoft connection — only the env var flips.
 *
 * Returns the path WITHOUT trailing slash. Callers compose
 * `https://graph.microsoft.com/v1.0${getMailboxBase()}/messages/...`.
 */
export function getMailboxBase(): string {
  const upn = (process.env.AUTOMATION_POLL_MAILBOX_UPN || "").trim();
  return upn ? `/users/${encodeURIComponent(upn)}` : "/me";
}

/**
 * Return ALL mailbox bases the poller should read this tick. Resolution
 * order:
 *   1. `AUTOMATION_POLL_MAILBOX_UPNS` (comma-separated, e.g.
 *      "alicia@thewolfpack.agency,homyk@thewolfpack.agency"). Each entry
 *      becomes /users/<encoded-upn>. Whitespace and empty entries are
 *      dropped. The literal token `me` (case-insensitive) maps to /me
 *      so an operator's own inbox can be included in the rotation
 *      without requiring Mail.Read.Shared.
 *   2. `AUTOMATION_POLL_MAILBOX_UPN` (singular, legacy). Single
 *      /users/<encoded-upn>. Kept so existing deployments keep working.
 *   3. neither set → ["/me"] — the operator's own mailbox.
 *
 * The poller iterates over the returned bases sequentially per tick and
 * aggregates messages_seen / matched / ingested across all of them.
 * This is how the alicia@ + homyk@ split (Alicia receives some Cognito
 * notifications, the operator receives the rest while parallel-testing)
 * lands in one ingest pipeline without dropping either side.
 */
export function getMailboxBases(): string[] {
  const list = (process.env.AUTOMATION_POLL_MAILBOX_UPNS || "").trim();
  if (list) {
    const bases = list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((upn) =>
        upn.toLowerCase() === "me" ? "/me" : `/users/${encodeURIComponent(upn)}`,
      );
    if (bases.length > 0) return bases;
  }
  const upn = (process.env.AUTOMATION_POLL_MAILBOX_UPN || "").trim();
  if (upn) return [`/users/${encodeURIComponent(upn)}`];
  return ["/me"];
}

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
/* Delta fallback — direct inbox listing when delta returns 0 items    */
/* ------------------------------------------------------------------ */
//
// Microsoft occasionally rebuilds the per-mailbox delta index (post
// mailbox-move events, server migrations, or quota repairs). During
// that window the delta endpoint returns 0 items even though the
// underlying inbox has fresh messages — confirmed via a Graph probe on
// 2026-04-28 when /me/mailFolders/inbox/messages returned a brand-new
// cognitoforms email but /messages/delta returned 0. This fallback
// preserves automation throughput across those events: when delta
// returns 0, we list the inbox directly with a receivedDateTime filter.
// We do NOT save a deltaLink from the fallback path — the next poll
// will retry delta and resume normal operation once Microsoft's index
// is healthy again.

async function listInboxSince(
  userId: string,
  sinceIso: string,
): Promise<GraphMailMessage[]> {
  /* Re-resolve the token here instead of reusing the preToken captured
     at the start of the poll. The delta call (called between preToken
     capture and this fallback) can spend hundreds of ms in a token
     refresh cycle; by the time we reach the fallback, preToken may
     have expired or been invalidated by a refresh. getValidToken
     always returns a fresh access_token (refreshing on demand), which
     is the same code path the diag probe uses — and the probe's
     identical URL is confirmed to return data. */
  const tok = await getValidToken(userId);
  if (!tok) {
    throw new Error("inbox list fallback: no_valid_token at fallback time");
  }
  /* IMPORTANT: do NOT use URL/URLSearchParams here. searchParams.set
     encodes spaces as `+` (form-urlencoded style), but Graph's OData
     parser only accepts `%20` for spaces in $filter / $orderby
     values. The `+` form silently returns 0 rows even though the
     query is otherwise valid (confirmed against homyk's mailbox on
     2026-04-28: searchParams form returned 0; manual string with
     fetch's auto-encoding returned 48 including the cognito email).
     Build the URL by hand and let fetch's encoder turn the literal
     space in `$orderby` and the encodeURIComponent'd `$filter` into
     `%20`. */
  const select =
    "id,subject,bodyPreview,from,toRecipients,hasAttachments,receivedDateTime,lastModifiedDateTime";
  const filter = `receivedDateTime ge ${sinceIso}`;
  const url =
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages` +
    `?$top=50&$orderby=receivedDateTime desc` +
    `&$select=${select}` +
    `&$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `inbox list fallback failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as { value?: GraphMailMessage[] };
  return body.value ?? [];
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
  /** Optional explicit Graph base — when polling across multiple
   *  mailboxes, attachments must be fetched from the SAME base the
   *  message was discovered in. Falls back to getMailboxBase() so
   *  every existing single-mailbox caller keeps working. */
  baseOverride?: string,
): Promise<Array<{ name: string; contentType: string; bytes: Buffer }>> {
  const token = await getValidToken(userId);
  if (!token) {
    throw new GraphClientError(
      401,
      "no_token",
      `inbox-poller: no token for user ${userId}`,
    );
  }
  const base = baseOverride ?? getMailboxBase();
  /* IMPORTANT: do NOT include `contentBytes` in the LIST $select. Graph
     drops items from the list response when contentBytes is requested
     there (it's a large property only resolvable on individual
     /attachments/{id} fetches). The earlier shape silently returned []
     for messages whose only attachment was a real fileAttachment. We
     now list the attachments first (cheap), then fetch each
     fileAttachment individually with bytes. */
  const listUrl = `https://graph.microsoft.com/v1.0${base}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`;
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
    const oneUrl = `https://graph.microsoft.com/v1.0${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}`;
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

/**
 * For Cognito-style emails (Entry Details in the body, no attachment),
 * pick the right parser based on the SUBJECT line. Returns null when
 * the subject doesn't advertise a known body-source. Pure helper —
 * exported for tests.
 */
export function detectBodySourceType(
  subject: string,
  automation: AutomationDefinition,
): AutomationSourceType | null {
  const s = (subject ?? "").toLowerCase();
  if (
    "cognito_coordinator" in automation.parsers &&
    /coordinator class report/i.test(s)
  ) {
    return "cognito_coordinator";
  }
  if (
    "cognito_instructor" in automation.parsers &&
    /instructor class report/i.test(s)
  ) {
    return "cognito_instructor";
  }
  return null;
}

/**
 * Build a minimal RFC822-shaped buffer from a Graph mail message that
 * `extractEmlParts` (cognito-html.ts) can parse. Graph delivers the
 * body as JSON {contentType, content}; the Cognito parsers expect to
 * read raw .eml bytes. Synthesizing a simple single-part eml with
 * `Content-Type: text/html` lets the existing parser pipeline run
 * unchanged.
 */
export function synthesizeEmlFromGraphMessage(msg: GraphMailMessage): Buffer {
  const ext = msg as unknown as {
    body?: { contentType?: string | null; content?: string | null };
  };
  const subject = (msg.subject ?? "").replace(/[\r\n]/g, " ");
  const fromAddr = msg.from?.emailAddress?.address ?? "";
  const fromName = msg.from?.emailAddress?.name ?? "";
  const fromHeader = fromName
    ? `${fromName} <${fromAddr}>`
    : fromAddr;
  const date = msg.receivedDateTime ?? new Date().toISOString();
  const messageId = msg.id ?? "";
  const isHtml = (ext.body?.contentType ?? "").toLowerCase() === "html";
  const contentTypeHeader = isHtml
    ? "text/html; charset=UTF-8"
    : "text/plain; charset=UTF-8";
  const bodyContent = ext.body?.content ?? msg.bodyPreview ?? "";
  const headerBlock =
    `Subject: ${subject}\r\n` +
    `From: ${fromHeader}\r\n` +
    `Date: ${date}\r\n` +
    `Message-Id: <${messageId}>\r\n` +
    `Content-Type: ${contentTypeHeader}\r\n` +
    `\r\n`;
  return Buffer.from(headerBlock + bodyContent, "utf8");
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
  /** Set when delta returned 0 AND the inbox-list fallback threw —
      surfaced so operators can tell "Graph rejected the fallback URL"
      from "Graph really has no recent mail" without checking logs. */
  fallback_error?: string;
  /** Which Graph access strategy actually ran. Surfaced so operators
      can tell at a glance whether `AUTOMATION_POLL_MAILBOX_UPN` is
      driving search-mode (and thus which env var change applies)
      versus the standard delta+inbox-list path. */
  mode?: "delta" | "delta+fallback" | "search";
  /** Per-mailbox results when search mode polled multiple bases this
      tick (AUTOMATION_POLL_MAILBOX_UPNS). Each entry shows what THAT
      mailbox contributed so operators can see, e.g., "alicia got 0,
      homyk got the cognito email". Absent on single-base ticks. */
  bases_polled?: Array<{
    base: string;
    messages_seen: number;
    messages_matched: number;
    artifacts_ingested: number;
    artifacts_duplicate: number;
    artifacts_quarantined: number;
    errors: number;
    skipped: PollResult["skipped"] | null;
  }>;
}

export async function pollInbox(args: {
  automationId: AutomationId;
  userId: string;
  userRole: string;
}): Promise<PollResult> {
  /* Dispatch — when AUTOMATION_POLL_MAILBOX_UPN(S) is set, we are
     reading mailboxes we may not own (e.g. Alicia's). Server-side
     $search with the automation's filter list is the privacy-safe
     path: only messages matching the configured senders/subjects ever
     cross the wire. Delta polling has no $search support and would
     pull every inbox-message metadata through our code.

     Multi-mailbox: AUTOMATION_POLL_MAILBOX_UPNS (plural, comma-
     separated) lets one tick span multiple mailboxes. Used when
     Cognito notifications fan out to two recipients (Alicia for the
     manual workflow, plus the operator for parallel-testing) — both
     mailboxes need polling so neither side drops messages. */
  const bases = getMailboxBases();
  const usingSearch = bases.some((b) => b !== "/me") || bases.length > 1;
  if (usingSearch) {
    return pollInboxAcrossBases(args, bases);
  }
  return pollInboxByDelta(args);
}

/**
 * Search-mode poll across N mailbox bases. Iterates the bases
 * sequentially (Graph quotas are per-token, not per-mailbox, so
 * parallel adds no real gain and risks throttling), aggregates the
 * per-base PollResults, and returns one combined PollResult. Surfaces
 * the per-base counts in `bases_polled` so the diag can render which
 * mailbox produced what.
 */
async function pollInboxAcrossBases(
  args: { automationId: AutomationId; userId: string; userRole: string },
  bases: string[],
): Promise<PollResult> {
  const start = Date.now();
  let messages_seen = 0;
  let messages_matched = 0;
  let artifacts_ingested = 0;
  let artifacts_duplicate = 0;
  let artifacts_quarantined = 0;
  let errors = 0;
  let firstSkipped: PollResult["skipped"] | undefined;
  const perBase: PollResult["bases_polled"] = [];

  for (const base of bases) {
    const r = await pollInboxBySearch(args, base);
    perBase!.push({
      base,
      messages_seen: r.messages_seen,
      messages_matched: r.messages_matched,
      artifacts_ingested: r.artifacts_ingested,
      artifacts_duplicate: r.artifacts_duplicate,
      artifacts_quarantined: r.artifacts_quarantined,
      errors: r.errors,
      skipped: r.skipped ?? null,
    });
    messages_seen += r.messages_seen;
    messages_matched += r.messages_matched;
    artifacts_ingested += r.artifacts_ingested;
    artifacts_duplicate += r.artifacts_duplicate;
    artifacts_quarantined += r.artifacts_quarantined;
    errors += r.errors;
    if (r.skipped && !firstSkipped) firstSkipped = r.skipped;
  }

  return {
    automation_id: args.automationId,
    messages_seen,
    messages_matched,
    artifacts_ingested,
    artifacts_duplicate,
    artifacts_quarantined,
    errors,
    duration_ms: Date.now() - start,
    mode: "search",
    bases_polled: perBase,
    /* Only surface skipped when EVERY base skipped — partial skip is
       not the same as the whole tick failing. */
    ...(firstSkipped && perBase!.every((b) => b.skipped) ? { skipped: firstSkipped } : {}),
  };
}

async function pollInboxByDelta(args: {
  automationId: AutomationId;
  userId: string;
  userRole: string;
}): Promise<PollResult> {
  const start = Date.now();
  const automation = getAutomation(args.automationId);
  if (!automation) {
    throw new Error(`unknown automation: ${args.automationId}`);
  }

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

  /* Delta fallback. When Graph's per-mailbox delta index is rebuilding
     (transient post-mailbox-move event), delta returns 0 items even
     when fresh messages exist in Inbox. Drop to a direct inbox list
     for the last 7 days so ingest doesn't stall for hours. We rely on
     the artifact dedupe (source_message_id, content_sha256) to keep
     reprocessing safe across consecutive polls. `triedFallback` is
     true whenever delta returned 0 items, regardless of whether the
     fallback itself found anything — used below to suppress the
     deltaLink save, since a 0-item delta response cannot be trusted
     to produce a usable cursor for the next tick. */
  let triedFallback = false;
  let fallbackError: string | null = null;
  if (items.length === 0) {
    triedFallback = true;
    /* 30-day backward window. Operators want past classes populated
       on the dashboard from the historical mail in their inbox, not
       just the last week. Graph $top: 50 caps the per-call return,
       so very-deep backfills still need pagination — but for a
       month of class-summary mail this typically pulls every match
       in one call. Keep in sync with the search-mode fallback
       below. */
    const sinceIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    try {
      items = await listInboxSince(args.userId, sinceIso);
    } catch (err) {
      fallbackError = (err as Error).message;
      console.warn(
        `[automations/inbox-poller] inbox-list fallback failed: ${fallbackError}`,
      );
    }
  }
  const usedFallback = triedFallback && items.length > 0;

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
    const r = await processMatchedMessage(msg, automation, args, messageLevel);
    artifactsIngested += r.ingested;
    artifactsDuplicate += r.duplicate;
    artifactsQuarantined += r.quarantined;
    errors += r.errors;
  }

  /* Only persist the delta cursor when delta itself returned a fresh
     link AND items > 0. A 0-item delta response — even one carrying a
     nextDeltaLink — is the signature of an index-rebuild window; saving
     that cursor would let the empty state stick across polls and keep
     the fallback from ever firing again. */
  if (nextDeltaLink && !triedFallback) {
    await saveDeltaLink(args.automationId, args.userId, nextDeltaLink);
  }

  const duration_ms = Date.now() - start;
  trackEvent("automations.poll_run", args.userId, args.userRole, {
    automation_id: args.automationId,
    mode: usedFallback ? "delta+inbox-list-fallback" : "delta",
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
    mode: triedFallback ? "delta+fallback" : "delta",
    ...(fallbackError ? { fallback_error: fallbackError } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Per-message ingest                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run a single matched message through the ingest pipeline. Extracted
 * from the delta-poll loop so the new search-poll path can reuse the
 * exact same data + learning integration (attachment ingest, body-
 * Cognito synthesis, message-level meeting ingest, dedup counting).
 *
 * Counters are returned per-message so the caller can aggregate across
 * the batch. NEVER throws — all failure paths increment `errors`.
 */
async function processMatchedMessage(
  msg: GraphMailMessage,
  automation: AutomationDefinition,
  args: { userId: string; userRole: string },
  messageLevel: boolean,
  /** Optional Graph base — must match the mailbox the message was
   *  discovered in. Critical when polling multiple mailboxes per tick
   *  (AUTOMATION_POLL_MAILBOX_UPNS) so attachment fetches don't go to
   *  the wrong /users/{upn}. Defaults to getMailboxBase() for legacy
   *  callers. */
  baseOverride?: string,
): Promise<{ ingested: number; duplicate: number; quarantined: number; errors: number }> {
  let ingested = 0;
  let duplicate = 0;
  let quarantined = 0;
  let errors = 0;

  let attachments: Awaited<ReturnType<typeof fetchAttachments>>;
  try {
    attachments = await fetchAttachments(args.userId, msg.id, baseOverride);
  } catch (err) {
    console.warn(
      `[automations/inbox-poller] attachment fetch failed for ${msg.id}: ${(err as Error).message}`,
    );
    return { ingested, duplicate, quarantined, errors: errors + 1 };
  }

  if (messageLevel) {
    // Message-level ingest path (meeting-insights): one row per email
    // regardless of attachments. The orchestrator owns body parsing +
    // attachment extraction internally.
    try {
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
        raw_bytes: Buffer.from(JSON.stringify(msg), "utf8"),
        mime: "message/rfc822",
        body_html: bodyHtml,
        body_preview: msg.bodyPreview ?? null,
        attachments,
        user_id: args.userId,
        user_role: args.userRole,
      });
      if (result.was_duplicate) duplicate += 1;
      else if (result.parse_status === "processed") ingested += 1;
      else if (result.parse_status === "error_quarantined") quarantined += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        `[automations/inbox-poller] meeting ingest failed for ${msg.id}: ${(err as Error).message}`,
      );
    }
    return { ingested, duplicate, quarantined, errors };
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
      if (result.was_duplicate) duplicate += 1;
      else if (result.parse_status === "processed") ingested += 1;
      else if (result.parse_status === "error_quarantined") quarantined += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        `[automations/inbox-poller] ingest failed for ${msg.id}/${att.name}: ${(err as Error).message}`,
      );
    }
  }

  /* Body-level Cognito path: synthesize .eml from Graph message body
     when no parseable attachment was found, so the parser-cognito-*
     pipeline runs unchanged. */
  const bodySourceType = detectBodySourceType(msg.subject ?? "", automation);
  if (bodySourceType && attachments.length === 0) {
    const emlBytes = synthesizeEmlFromGraphMessage(msg);
    try {
      const result: IngestResult = await ingestArtifact({
        automation,
        source_type: bodySourceType,
        source_message_id: msg.id,
        received_at: msg.receivedDateTime ?? new Date().toISOString(),
        bytes: emlBytes,
        hint: msg.subject ?? `${bodySourceType}.eml`,
        mime: "message/rfc822",
        user_id: args.userId,
        user_role: args.userRole,
      });
      if (result.was_duplicate) duplicate += 1;
      else if (result.parse_status === "processed") ingested += 1;
      else if (result.parse_status === "error_quarantined") quarantined += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        `[automations/inbox-poller] body ingest failed for ${msg.id}: ${(err as Error).message}`,
      );
    }
  }

  return { ingested, duplicate, quarantined, errors };
}

/* ------------------------------------------------------------------ */
/* Search-mode poll                                                    */
/*                                                                     */
/* Used when AUTOMATION_POLL_MAILBOX_UPN is set — the cron reads a     */
/* mailbox the operator doesn't own. Server-side $search guarantees    */
/* only matching messages ever cross the wire from Graph, which is     */
/* the privacy contract for reading another user's inbox.              */
/*                                                                     */
/* Cursor reuses the existing delta_link column with a "search:" ISO   */
/* timestamp prefix to avoid a schema migration. The poller advances   */
/* the cursor to the newest receivedDateTime seen this tick. Delta     */
/* and search modes never share a cursor — the prefix is the discriminator. */
/* ------------------------------------------------------------------ */

const SEARCH_CURSOR_PREFIX = "search:";

function parseSearchCursor(stored: string | null): string | null {
  if (!stored || !stored.startsWith(SEARCH_CURSOR_PREFIX)) return null;
  const iso = stored.slice(SEARCH_CURSOR_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso : null;
}

function formatSearchCursor(iso: string): string {
  return `${SEARCH_CURSOR_PREFIX}${iso}`;
}

async function pollInboxBySearch(
  args: {
    automationId: AutomationId;
    userId: string;
    userRole: string;
  },
  /** Explicit Graph base to read from. When omitted, falls back to
   *  the legacy single-base resolution (`getMailboxBase()`). The
   *  multi-mailbox driver (`pollInboxAcrossBases`) passes one base
   *  per iteration so each mailbox runs through the same code path. */
  baseOverride?: string,
): Promise<PollResult> {
  const start = Date.now();
  const automation = getAutomation(args.automationId);
  if (!automation) {
    throw new Error(`unknown automation: ${args.automationId}`);
  }
  const base = baseOverride ?? getMailboxBase();

  const preToken = await getValidToken(args.userId);
  if (!preToken) {
    try {
      trackEvent("automations.poll_skipped", args.userId, args.userRole, {
        automation_id: args.automationId,
        mode: "search",
        reason: "no_user_connected",
      });
    } catch {
      /* analytics best-effort */
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

  const activeFilters = await resolveActiveInboxFilters(automation);
  const searchClause = buildSearchClause(activeFilters);
  if (!searchClause) {
    /* No filters configured — we WILL NOT poll a third-party mailbox
       without a server-side filter. Refuse loudly so a misconfiguration
       can't accidentally pull every email. */
    try {
      trackEvent("automations.poll_skipped", args.userId, args.userRole, {
        automation_id: args.automationId,
        mode: "search",
        reason: "no_filters_in_search_mode",
      });
    } catch {
      /* best-effort */
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
      skipped: "no_user_connected", // reuse the existing skipped enum value
    };
  }

  /* Per-base cursor: when an explicit base is provided (multi-mailbox
     mode), suffix the cursor key with the base so each mailbox tracks
     its own newest-received timestamp. Single-base callers keep the
     legacy plain-userId key — no schema change. */
  const cursorKey = baseOverride ? `${args.userId}::${baseOverride}` : args.userId;
  const stored = await loadDeltaLink(args.automationId, cursorKey);
  const since = parseSearchCursor(stored);

  /* Compose the Graph URL: /{base}/mailFolders/inbox/messages with
     server-side $search (sender + subject KQL) — only messages
     matching the automation's filters cross the wire. The
     receivedDateTime $filter further restricts to NEW messages since
     last successful poll. ConsistencyLevel: eventual is required by
     Graph for $search + $filter.

     CRITICAL: do NOT use URL/URLSearchParams. searchParams.set
     encodes spaces as `+` (form-urlencoded), but Graph KQL silently
     returns 0 results when $search/$orderby contain `+` instead of
     `%20`. Build the URL by hand and let encodeURIComponent (which
     produces %20 for spaces) handle the values. (Confirmed against
     homyk@thewolfpack.agency 2026-04-28: searchParams form returned
     0 across 10+ manual runs; manual encodeURIComponent path returns
     the expected hits.) */
  const select =
    "id,subject,bodyPreview,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments";
  const urlString =
    `https://graph.microsoft.com/v1.0${base}/mailFolders/inbox/messages` +
    `?$top=50` +
    `&$select=${encodeURIComponent(select)}` +
    `&$search=${encodeURIComponent(`"${searchClause}"`)}`;
  /* NOTE: Graph rejects $filter alongside $search in many cases — we
     apply the receivedDateTime cutoff client-side for safety. The
     $top: 50 cap protects from runaway when the cursor is far behind. */

  let payload: { value?: GraphMailMessage[] } = {};
  try {
    const res = await fetch(urlString, {
      headers: {
        Authorization: `Bearer ${preToken.accessToken}`,
        ConsistencyLevel: "eventual",
      },
    });
    if (res.status === 401 || res.status === 403) {
      try {
        trackEvent("automations.poll_skipped", args.userId, args.userRole, {
          automation_id: args.automationId,
          mode: "search",
          reason: res.status === 401 ? "no_valid_token" : "scope_or_access_missing",
          status: res.status,
        });
      } catch {
        /* best-effort */
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
        skipped: res.status === 401 ? "no_valid_token" : "no_user_connected",
      };
    }
    if (!res.ok) {
      console.warn(
        `[automations/inbox-poller] search-mode graph_${res.status}`,
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
    payload = (await res.json()) as { value?: GraphMailMessage[] };
  } catch (err) {
    console.warn(
      `[automations/inbox-poller] search-mode fetch threw: ${(err as Error).message}`,
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

  let items = payload.value ?? [];
  /* Search-mode fallback. Graph $search with delegated tokens against
     /users/{upn}/messages can silently return 0 even when the inbox
     genuinely contains matching mail — confirmed against
     homyk@thewolfpack.agency 2026-04-28 with a known cognito email
     in inbox. Cause is opaque (likely a KQL parser quirk for nested
     AND/OR clauses with mixed quoted/unquoted values), and there's
     no error response to discriminate on.

     Drop to a direct inbox listing for the last 30 days when $search
     returns 0, then re-apply the client-side filter. Privacy is
     preserved: only matching messages are processed downstream;
     non-matching ones are skipped without storage. The token already
     has Mail.Read.Shared, so reading the metadata is in scope.

     30-day window matches the delta-mode fallback so an operator can
     populate "This week" with the recent past classes by clicking
     Run-now once — no separate backfill flow needed for short
     histories. Deeper history still requires the explicit historical
     scan endpoint. */
  let usedSearchFallback = false;
  if (items.length === 0) {
    try {
      const sinceIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const fbSelect =
        "id,subject,bodyPreview,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments";
      const fbFilter = `receivedDateTime ge ${sinceIso}`;
      const fbUrl =
        `https://graph.microsoft.com/v1.0${base}/mailFolders/inbox/messages` +
        `?$top=50&$orderby=receivedDateTime desc` +
        `&$select=${fbSelect}` +
        `&$filter=${encodeURIComponent(fbFilter)}`;
      const fbRes = await fetch(fbUrl, {
        headers: { Authorization: `Bearer ${preToken.accessToken}` },
      });
      if (fbRes.ok) {
        const fb = (await fbRes.json()) as { value?: GraphMailMessage[] };
        items = fb.value ?? [];
        usedSearchFallback = true;
      } else {
        console.warn(
          `[automations/inbox-poller] search-mode fallback to inbox-list failed: ${base} → ${fbRes.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[automations/inbox-poller] search-mode fallback threw for ${base}: ${(err as Error).message}`,
      );
    }
  }

  const messagesSeen = items.length;
  let messagesMatched = 0;
  let artifactsIngested = 0;
  let artifactsDuplicate = 0;
  let artifactsQuarantined = 0;
  let errors = 0;
  let newestSeen: string | null = since;

  const messageLevel = isMessageLevelIngest(automation);

  for (const msg of items) {
    const rcv = msg.receivedDateTime ?? null;
    if (since && rcv && rcv <= since) continue; // already processed
    /* Defense-in-depth: even though $search filtered server-side,
       re-apply the client-side filter so a Graph quirk (KQL behavior
       differences across mailboxes) can never bypass the contract.
       This is the PRIMARY filter when usedSearchFallback is true. */
    if (!messageMatchesAutomation(msg, automation, activeFilters)) continue;
    messagesMatched += 1;

    /* Graph's $search list response OMITS the body field even when
       $select includes it — known quirk, the body is only available via
       a per-message detail GET. Fetch full body + ccRecipients so the
       Cognito body-synth path can see the structured HTML. Without this
       the synthesized .eml has only the 255-char bodyPreview and the
       parser quarantines with "no text/html part". (Confirmed against
       the BA101 2026-04-20 Ritz Carlton coordinator email on 2026-04-27.) */
    try {
      const detailUrl = `https://graph.microsoft.com/v1.0${base}/messages/${encodeURIComponent(msg.id)}?$select=body,ccRecipients`;
      const detailRes = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${preToken.accessToken}` },
      });
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as {
          body?: { contentType?: string | null; content?: string | null };
          ccRecipients?: Array<{ emailAddress?: { address?: string | null } }>;
        };
        // Mutate in place — processMatchedMessage / synthesizeEml read msg.body.
        (msg as unknown as { body?: typeof detail.body }).body = detail.body;
        if (detail.ccRecipients) {
          (msg as unknown as { ccRecipients?: typeof detail.ccRecipients }).ccRecipients =
            detail.ccRecipients;
        }
      } else {
        console.warn(
          `[automations/inbox-poller] search-mode body-detail fetch failed for ${msg.id}: ${detailRes.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[automations/inbox-poller] search-mode body-detail threw for ${msg.id}: ${(err as Error).message}`,
      );
    }

    const r = await processMatchedMessage(msg, automation, args, messageLevel, base);
    artifactsIngested += r.ingested;
    artifactsDuplicate += r.duplicate;
    artifactsQuarantined += r.quarantined;
    errors += r.errors;
    if (rcv && (!newestSeen || rcv > newestSeen)) newestSeen = rcv;
  }

  /* Advance cursor only when we actually saw new messages — a poll
     with zero matches must not move the cursor forward (would skip
     mail that arrives between the search and the next tick). */
  if (newestSeen && newestSeen !== since) {
    await saveDeltaLink(args.automationId, cursorKey, formatSearchCursor(newestSeen));
  }

  const duration_ms = Date.now() - start;
  trackEvent("automations.poll_run", args.userId, args.userRole, {
    automation_id: args.automationId,
    mode: usedSearchFallback ? "search+inbox-list-fallback" : "search",
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
    mode: "search",
  };
}

// Exported for tests — never call from production code.
export const __searchModeInternalsForTests = {
  parseSearchCursor,
  formatSearchCursor,
  pollInboxBySearch,
};

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

/**
 * Whether a sender pattern is safe to put inside a KQL `from:` clause.
 *
 * `messageMatchesAutomation` (delta-mode client-side filter) accepts
 * substring patterns like `@thewolfpack.agency` or `@` as wildcards.
 * Those substrings are NOT valid KQL `from:` values — Graph either
 * rejects the query (silent return-0 behavior) or matches nothing.
 * Skip anything that's not a real-shaped email address (`local@host`).
 *
 * Confirmed against homyk@thewolfpack.agency 2026-04-28: a clause
 * containing `from:@` returned 0 across both alicia and homyk inboxes
 * even though the cognito email matched the other senders/subjects.
 */
function isKqlSafeSenderPattern(s: string): boolean {
  const at = s.indexOf("@");
  /* Must have at least one char before AND after the @ — rules out
     "@", "@host", "user@". Plain substrings like "@thewolfpack.agency"
     fail this check and get dropped from the KQL clause (they remain
     in the client-side filter list, so `messageMatchesAutomation`
     still applies them after Graph returns matches for the other
     real-email senders). */
  if (at <= 0) return false;
  if (at === s.length - 1) return false;
  return true;
}

function buildSearchClause(filters: HistoricalScanArgs["filters"]): string {
  const senders = (filters.sender_match ?? [])
    .filter(isKqlSafeSenderPattern)
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

  /* Same %20-vs-+ encoding hazard as pollInboxBySearch: build the URL
     by hand. URL.searchParams.set encodes spaces as `+`, which Graph
     KQL rejects silently. */
  const searchClause = buildSearchClause(args.filters);
  const histSelect =
    "id,subject,bodyPreview,from,toRecipients,ccRecipients,body,receivedDateTime,hasAttachments";
  let urlStr =
    `https://graph.microsoft.com/v1.0${getMailboxBase()}/mailFolders/inbox/messages` +
    `?$top=${limit}` +
    `&$select=${encodeURIComponent(histSelect)}`;
  if (searchClause) {
    urlStr += `&$search=${encodeURIComponent(`"${searchClause}"`)}`;
  } else {
    urlStr += `&$orderby=receivedDateTime desc`;
  }

  let items: GraphMailMessage[] = [];
  try {
    const res = await fetch(urlStr, {
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
          const detailUrl = `https://graph.microsoft.com/v1.0${getMailboxBase()}/messages/${encodeURIComponent(msg.id)}?$select=body,ccRecipients`;
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
