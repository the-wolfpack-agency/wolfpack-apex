/**
 * Microsoft 365 Mail integration (Mail.Send scope).
 *
 * Builds on the OAuth + token storage in `@/lib/microsoft-graph`. Handles
 * Mail.Send sendMail + reply. On success, writes a redacted history row
 * to instinct_sent_mail (see migration 022), records an audit entry, and
 * emits analytics so the learning loop can track reply rates + optimal
 * send hours.
 *
 * Never throws on an expected Graph failure: returns Result<T> so the API
 * route can surface scope_missing (403), rate_limited (429), or not
 * connected (401) distinctly. Unexpected failures are logged and returned
 * as a generic "internal" result code — callers can 500 them.
 *
 * Graph surface:
 *   POST /me/sendMail
 *   POST /me/messages/{id}/reply
 *
 * Rate limits: Graph returns 429 with Retry-After — honor it exactly once
 * (same pattern as microsoft-tasks), then surface as rate_limited.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type MailErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "invalid_input"
  | "graph_error"
  | "internal";

export interface MailErrorResult {
  ok: false;
  code: MailErrorCode;
  /** Graph scope that is missing (scope_missing only) */
  scope?: string;
  /** Retry-After seconds (rate_limited only) */
  retryAfter?: number;
  /** Underlying Graph status, if any */
  status?: number;
  /** Human message (developer-facing — UI uses `code` for copy) */
  message?: string;
}

export interface MailOkResult<T> {
  ok: true;
  value: T;
}

export type Result<T> = MailOkResult<T> | MailErrorResult;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface SendMailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  saveToSentItems?: boolean;
}

export interface ReplyInput {
  bodyHtml?: string;
  bodyText?: string;
}

export interface SentMailSummary {
  id: string;
  savedToSent: boolean;
}

export interface ReplySummary {
  id: string;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const BODY_PREVIEW_MAX = 512;

interface GraphCallSuccess<T> {
  ok: true;
  status: number;
  headers: Headers;
  data: T | null;
  messageId: string | null;
}

interface GraphCallError {
  ok: false;
  status: number;
  code: MailErrorCode;
  scope?: string;
  retryAfter?: number;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

/**
 * Normalize a Graph failure body into a scope_missing when the returned
 * error.code is one of the standard Graph authorization codes. Graph
 * surfaces missing-scope as 403 with code ErrorAccessDenied /
 * Authorization_RequestDenied / ErrorAccessDeniedMissingScope.
 */
function classify403(body: any, fallbackScope: string): { code: MailErrorCode; scope?: string; message: string } {
  const errCode =
    body?.error?.code ||
    body?.error?.innerError?.code ||
    "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) {
    return { code: "scope_missing", scope: fallbackScope, message: errMsg };
  }
  return { code: "graph_error", message: errMsg };
}

async function graphPost<T = unknown>(
  endpoint: string,
  accessToken: string,
  body: unknown,
  expectedScope: string,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;

  const doCall = () =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

  let res: Response;
  try {
    res = await doCall();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: "internal",
      message: `network_error: ${(err as Error).message}`,
    };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    let retry: Response;
    try {
      retry = await doCall();
    } catch (err) {
      return {
        ok: false,
        status: 0,
        code: "internal",
        retryAfter,
        message: `network_error_after_retry: ${(err as Error).message}`,
      };
    }
    if (retry.status === 429) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        retryAfter,
        message: "rate_limited_after_retry",
      };
    }
    res = retry;
  }

  if (res.status === 403) {
    const body = await safeJson(res);
    const c = classify403(body, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }

  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }

  if (!res.ok) {
    const text = await safeText(res);
    return {
      ok: false,
      status: res.status,
      code: "graph_error",
      message: `graph_${res.status}: ${text.slice(0, 200)}`,
    };
  }

  let data: T | null = null;
  let messageId: string | null = res.headers.get("x-ms-message-id") || null;
  if (res.status !== 202 && res.status !== 204) {
    data = (await safeJson(res)) as T;
    if (!messageId && data && typeof data === "object" && "id" in (data as any)) {
      messageId = String((data as any).id);
    }
  }
  return { ok: true, status: res.status, headers: res.headers, data, messageId };
}

// ---------------------------------------------------------------------------
// Normalization + helpers
// ---------------------------------------------------------------------------

function normalizeRecipients(list: string[] | undefined): { emailAddress: { address: string } }[] {
  return (list ?? [])
    .map((e) => (typeof e === "string" ? e.trim() : ""))
    .filter((e) => e.length > 0)
    .map((address) => ({ emailAddress: { address } }));
}

function buildMessageBody(input: { bodyHtml?: string; bodyText?: string }): {
  contentType: "HTML" | "Text";
  content: string;
} {
  if (input.bodyHtml && input.bodyHtml.length > 0) {
    return { contentType: "HTML", content: input.bodyHtml };
  }
  return { contentType: "Text", content: input.bodyText ?? "" };
}

/** Strip HTML tags, collapse whitespace, truncate to 512 chars. */
export function truncateBodyPreview(
  input: { bodyHtml?: string; bodyText?: string },
  max = BODY_PREVIEW_MAX,
): string {
  const raw = input.bodyText ?? input.bodyHtml ?? "";
  const stripped = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

function validateSendInput(input: SendMailInput): MailErrorResult | null {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "invalid_input", message: "missing_body" };
  }
  const to = normalizeRecipients(input.to);
  if (to.length === 0) {
    return { ok: false, code: "invalid_input", message: "to_required" };
  }
  if (!input.subject || typeof input.subject !== "string" || input.subject.trim().length === 0) {
    return { ok: false, code: "invalid_input", message: "subject_required" };
  }
  if (!input.bodyHtml && !input.bodyText) {
    return { ok: false, code: "invalid_input", message: "body_required" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache + audit + analytics
// ---------------------------------------------------------------------------

async function recordSendHistory(params: {
  userId: string;
  msMessageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyPreview: string;
  inReplyTo: string | null;
}): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO instinct_sent_mail
         (user_id, ms_message_id, to_recipients, cc_recipients, bcc_recipients,
          subject, body_preview, in_reply_to, sent_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'instinct')`,
      [
        params.userId,
        params.msMessageId,
        JSON.stringify(params.to),
        JSON.stringify(params.cc),
        JSON.stringify(params.bcc),
        params.subject,
        params.bodyPreview,
        params.inReplyTo,
      ],
    );
  } catch (err) {
    // Never throw — history is best-effort. Log and move on.
    console.warn("[microsoft-mail] Failed to write send history:", (err as Error).message);
  }
}

async function auditMailSent(params: {
  userId: string;
  role: string;
  action: "mail.sent" | "mail.replied";
  msMessageId: string;
  subject: string;
  to: string[];
  inReplyTo?: string | null;
}): Promise<void> {
  try {
    await recordAudit({
      actor: { user_id: params.userId, role: params.role },
      action: params.action,
      resourceType: "mail",
      resourceId: params.msMessageId,
      afterState: {
        subject: params.subject,
        to: params.to,
        in_reply_to: params.inReplyTo ?? null,
      },
    });
  } catch (err) {
    console.warn("[microsoft-mail] audit record failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a new mail via Graph `POST /me/sendMail`.
 *
 * On success: writes instinct_sent_mail, emits system.ms_mail_sent,
 * records audit "mail.sent". Returns { ok:true, value:{ id, savedToSent } }.
 * The `id` is Graph's message id when exposed (x-ms-message-id header);
 * Graph's sendMail often returns 202 with no body — in that case `id` is
 * a synthetic `sent:<timestamp>` placeholder so caller + cache have a stable
 * reference. Callers should treat `id` as opaque.
 *
 * On 403 (missing scope): returns { ok:false, code:"scope_missing",
 * scope:"Mail.Send" } — never throws.
 * On 429: honors Retry-After once, then returns rate_limited.
 * On 401: returns not_connected.
 */
export async function sendMail(
  userId: string,
  input: SendMailInput,
  role = "system",
): Promise<Result<SentMailSummary>> {
  const invalid = validateSendInput(input);
  if (invalid) return invalid;

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_mail_send_failed", userId, role, {
      reason: "not_connected",
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const saveToSentItems = input.saveToSentItems !== false;

  const message = {
    subject: input.subject,
    body: buildMessageBody(input),
    toRecipients: normalizeRecipients(input.to),
    ccRecipients: normalizeRecipients(input.cc),
    bccRecipients: normalizeRecipients(input.bcc),
  };

  const res = await graphPost<unknown>(
    "me/sendMail",
    token.accessToken,
    { message, saveToSentItems },
    "Mail.Send",
  );

  if (!res.ok) {
    trackEvent("system.ms_mail_send_failed", userId, role, {
      reason: res.code,
      status: res.status ?? 0,
      scope: res.scope ?? "",
    });
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const msMessageId = res.messageId ?? `sent:${Date.now()}`;
  const toList = input.to ?? [];
  const ccList = input.cc ?? [];
  const bccList = input.bcc ?? [];
  const bodyPreview = truncateBodyPreview(input);

  await recordSendHistory({
    userId,
    msMessageId,
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: input.subject,
    bodyPreview,
    inReplyTo: null,
  });

  await auditMailSent({
    userId,
    role,
    action: "mail.sent",
    msMessageId,
    subject: input.subject,
    to: toList,
  });

  trackEvent("system.ms_mail_sent", userId, role, {
    to_count: toList.length,
    cc_count: ccList.length,
    bcc_count: bccList.length,
    saved_to_sent: saveToSentItems,
    subject_len: input.subject.length,
    body_len: bodyPreview.length,
  });

  return { ok: true, value: { id: msMessageId, savedToSent: saveToSentItems } };
}

/**
 * Reply to an existing thread via Graph `POST /me/messages/{id}/reply`.
 * The reply is created + sent by Graph; we do not create a draft first.
 *
 * On success: writes instinct_sent_mail with in_reply_to = originalMessageId.
 * Emits system.ms_mail_reply_sent. Audit action is "mail.replied".
 *
 * Same error-handling contract as sendMail.
 */
export async function replyToMessage(
  userId: string,
  originalMessageId: string,
  input: ReplyInput,
  role = "system",
): Promise<Result<ReplySummary>> {
  if (!originalMessageId || typeof originalMessageId !== "string") {
    return { ok: false, code: "invalid_input", message: "original_message_id_required" };
  }
  if (!input || (!input.bodyHtml && !input.bodyText)) {
    return { ok: false, code: "invalid_input", message: "body_required" };
  }

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_mail_send_failed", userId, role, {
      reason: "not_connected",
      in_reply_to: originalMessageId,
    });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  // Graph's /reply endpoint takes { comment: string } OR a full message
  // override. Prefer comment for text-only, message.body for HTML so the
  // caller can send rich content.
  const body: Record<string, unknown> = {};
  if (input.bodyHtml && input.bodyHtml.length > 0) {
    body.message = { body: { contentType: "HTML", content: input.bodyHtml } };
  } else {
    body.comment = input.bodyText ?? "";
  }

  const res = await graphPost<unknown>(
    `me/messages/${encodeURIComponent(originalMessageId)}/reply`,
    token.accessToken,
    body,
    "Mail.Send",
  );

  if (!res.ok) {
    trackEvent("system.ms_mail_send_failed", userId, role, {
      reason: res.code,
      status: res.status ?? 0,
      in_reply_to: originalMessageId,
      scope: res.scope ?? "",
    });
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const msMessageId = res.messageId ?? `reply:${Date.now()}`;
  const bodyPreview = truncateBodyPreview(input);

  await recordSendHistory({
    userId,
    msMessageId,
    to: [],
    cc: [],
    bcc: [],
    subject: `(reply to ${originalMessageId})`,
    bodyPreview,
    inReplyTo: originalMessageId,
  });

  await auditMailSent({
    userId,
    role,
    action: "mail.replied",
    msMessageId,
    subject: `(reply to ${originalMessageId})`,
    to: [],
    inReplyTo: originalMessageId,
  });

  trackEvent("system.ms_mail_reply_sent", userId, role, {
    in_reply_to: originalMessageId,
    body_len: bodyPreview.length,
  });

  return { ok: true, value: { id: msMessageId } };
}

// ---------------------------------------------------------------------------
// Read a single message (used by /emails?id=<id> deep-link reading view)
// ---------------------------------------------------------------------------

export interface MessageDetail {
  id: string;
  subject: string;
  from: { name: string; email: string };
  toRecipients: { name: string; email: string }[];
  ccRecipients: { name: string; email: string }[];
  receivedDateTime: string;
  bodyContentType: "html" | "text";
  bodyContent: string;
  bodyPreview: string;
  webLink: string;
}

async function graphGet<T = unknown>(
  endpoint: string,
  accessToken: string,
  expectedScope: string,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: "internal",
      message: `network_error: ${(err as Error).message}`,
    };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1,
      message: "rate_limited",
    };
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    const c = classify403(body, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "graph_error", message: "not_found" };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return {
      ok: false,
      status: res.status,
      code: "graph_error",
      message: `graph_${res.status}: ${text.slice(0, 200)}`,
    };
  }
  const data = (await safeJson(res)) as T;
  return { ok: true, status: res.status, headers: res.headers, data, messageId: null };
}

interface RawRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface RawMessage {
  id: string;
  subject: string;
  from?: RawRecipient | null;
  toRecipients?: RawRecipient[];
  ccRecipients?: RawRecipient[];
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  webLink?: string;
}

function normalizeRecipientList(list: RawRecipient[] | undefined): { name: string; email: string }[] {
  return (list ?? [])
    .map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    }))
    .filter((r) => r.email);
}

/**
 * Fetch a single Outlook message by its Graph id. Returns the full
 * body so the reading view can render it. Used by `GET /api/mail/[id]`
 * which the search → /emails?id=<id> deep-link consumes.
 *
 * Mail.Read scope only — strictly less than the Mail.Send scope used
 * by send/reply.
 */
export async function getMessage(userId: string, id: string): Promise<Result<MessageDetail>> {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    return { ok: false, code: "invalid_input", message: "id required" };
  }
  const token = await getValidToken(userId);
  if (!token) {
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const select = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,webLink";
  const path = `me/messages/${encodeURIComponent(cleanId)}?$select=${encodeURIComponent(select)}`;
  const res = await graphGet<RawMessage>(path, token.accessToken, "Mail.Read");

  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  const m = res.data;
  if (!m) {
    return { ok: false, code: "graph_error", status: res.status, message: "empty_response" };
  }

  const detail: MessageDetail = {
    id: m.id,
    subject: m.subject ?? "",
    from: {
      name: m.from?.emailAddress?.name ?? "",
      email: m.from?.emailAddress?.address ?? "",
    },
    toRecipients: normalizeRecipientList(m.toRecipients),
    ccRecipients: normalizeRecipientList(m.ccRecipients),
    receivedDateTime: m.receivedDateTime ?? "",
    bodyContentType: m.body?.contentType?.toLowerCase() === "html" ? "html" : "text",
    bodyContent: m.body?.content ?? "",
    bodyPreview: m.bodyPreview ?? "",
    webLink: m.webLink ?? "",
  };

  trackEvent("system.ms_mail_read", userId, "system", { id: cleanId });
  return { ok: true, value: detail };
}

// ---------------------------------------------------------------------------
// Inbox listing + mutation helpers (Reply-All / Forward / Archive / Delete /
// Mark-Read). Used by the /emails inbox view to make Instinct a credible
// Outlook replacement — every action below is a single, typed Graph call so
// the UI never has to talk to Graph directly.
// ---------------------------------------------------------------------------

export interface InboxMessageSummary {
  id: string;
  subject: string;
  from: { name: string; email: string };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: "low" | "normal" | "high";
  webLink: string;
}

export interface ListInboxOptions {
  /** Default 25, capped at 100 to keep payload sane. */
  top?: number;
  /** Filter on isRead=false (unread only). */
  unreadOnly?: boolean;
  /** OData $skip for paging — cheap because we $orderby receivedDateTime. */
  skip?: number;
  /** Folder. Defaults to "inbox". */
  folder?: string;
}

export interface ListInboxPage {
  messages: InboxMessageSummary[];
  /** Next $skip value, or null when the page is the tail. */
  nextSkip: number | null;
  unreadCount?: number;
}

interface RawInboxMessage {
  id: string;
  subject?: string | null;
  from?: RawRecipient | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  isRead?: boolean | null;
  hasAttachments?: boolean | null;
  importance?: string | null;
  webLink?: string | null;
}

function normalizeImportance(v: string | null | undefined): "low" | "normal" | "high" {
  const s = String(v ?? "").toLowerCase();
  if (s === "low" || s === "high") return s;
  return "normal";
}

function normalizeInboxRow(m: RawInboxMessage): InboxMessageSummary {
  return {
    id: m.id,
    subject: m.subject ?? "",
    from: {
      name: m.from?.emailAddress?.name ?? "",
      email: m.from?.emailAddress?.address ?? "",
    },
    receivedDateTime: m.receivedDateTime ?? "",
    bodyPreview: m.bodyPreview ?? "",
    isRead: Boolean(m.isRead),
    hasAttachments: Boolean(m.hasAttachments),
    importance: normalizeImportance(m.importance),
    webLink: m.webLink ?? "",
  };
}

/**
 * List messages from the user's inbox folder. Mail.Read scope only.
 * Returns up to `top` rows ordered newest-first. Pagination is `$skip`
 * based — Graph's `@odata.nextLink` would also work but `$skip` keeps
 * the cursor stateless on the client.
 */
export async function listInbox(
  userId: string,
  opts: ListInboxOptions = {},
): Promise<Result<ListInboxPage>> {
  const top = Math.min(Math.max(Number.isFinite(opts.top) ? Number(opts.top) : 25, 1), 100);
  const skip = Math.max(Number.isFinite(opts.skip) ? Number(opts.skip) : 0, 0);
  const folder = (opts.folder ?? "inbox").replace(/[^a-zA-Z0-9_-]/g, "") || "inbox";

  const token = await getValidToken(userId);
  if (!token) {
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const select =
    "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance,webLink";
  const order = "receivedDateTime desc";
  const filter = opts.unreadOnly ? "isRead eq false" : "";
  const params: string[] = [
    `$top=${top}`,
    `$skip=${skip}`,
    `$orderby=${encodeURIComponent(order)}`,
    `$select=${encodeURIComponent(select)}`,
    `$count=true`,
  ];
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);

  const path = `me/mailFolders/${folder}/messages?${params.join("&")}`;
  const res = await graphGet<{ value?: RawInboxMessage[]; "@odata.count"?: number }>(
    path,
    token.accessToken,
    "Mail.Read",
  );

  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const rows = Array.isArray(res.data?.value) ? res.data!.value! : [];
  const messages = rows.map(normalizeInboxRow);
  const totalCount =
    typeof res.data?.["@odata.count"] === "number" ? res.data!["@odata.count"] : undefined;
  const nextSkip = messages.length === top ? skip + top : null;

  trackEvent("system.ms_mail_listed", userId, "system", {
    folder,
    count: messages.length,
    unread_only: Boolean(opts.unreadOnly),
    top,
    skip,
  });

  return {
    ok: true,
    value: {
      messages,
      nextSkip,
      unreadCount: opts.unreadOnly ? totalCount : undefined,
    },
  };
}

/**
 * PATCH a single Outlook message — used to flip isRead.
 *
 * Mail.ReadWrite scope. Falls under the same scope_missing surface so
 * the UI can prompt the user to reconnect when needed.
 */
async function graphPatch<T = unknown>(
  endpoint: string,
  accessToken: string,
  body: unknown,
  expectedScope: string,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return { ok: false, status: 429, code: "rate_limited", retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1, message: "rate_limited" };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    const c = classify403(body, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "graph_error", message: "not_found" };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${text.slice(0, 200)}` };
  }
  let data: T | null = null;
  if (res.status !== 204) {
    data = (await safeJson(res)) as T;
  }
  return { ok: true, status: res.status, headers: res.headers, data, messageId: null };
}

async function graphDelete(
  endpoint: string,
  accessToken: string,
  expectedScope: string,
): Promise<GraphCallSuccess<unknown> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return { ok: false, status: 429, code: "rate_limited", retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1, message: "rate_limited" };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    const c = classify403(body, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: "graph_error", message: "not_found" };
  }
  if (!res.ok) {
    const text = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true, status: res.status, headers: res.headers, data: null, messageId: null };
}

/**
 * Mark a message read or unread. Wraps PATCH /me/messages/{id} with
 * { isRead: boolean }.
 */
export async function setMessageReadState(
  userId: string,
  id: string,
  isRead: boolean,
): Promise<Result<{ id: string; isRead: boolean }>> {
  const cleanId = String(id || "").trim();
  if (!cleanId) return { ok: false, code: "invalid_input", message: "id required" };
  const token = await getValidToken(userId);
  if (!token) return { ok: false, code: "not_connected", message: "microsoft_not_connected" };

  const res = await graphPatch<unknown>(
    `me/messages/${encodeURIComponent(cleanId)}`,
    token.accessToken,
    { isRead },
    "Mail.ReadWrite",
  );
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  trackEvent("system.ms_mail_read_state_changed", userId, "system", { id: cleanId, is_read: isRead });
  return { ok: true, value: { id: cleanId, isRead } };
}

/**
 * Move the message to the Archive folder via Graph's /move action. A move
 * is two operations server-side (copy + delete) but the API surface is
 * one POST. Returns the new message id Graph hands back.
 */
export async function archiveMessage(
  userId: string,
  id: string,
): Promise<Result<{ id: string }>> {
  const cleanId = String(id || "").trim();
  if (!cleanId) return { ok: false, code: "invalid_input", message: "id required" };
  const token = await getValidToken(userId);
  if (!token) return { ok: false, code: "not_connected", message: "microsoft_not_connected" };

  // Graph's well-known Archive folder is reachable via /mailFolders/archive.
  const res = await graphPost<{ id?: string }>(
    `me/messages/${encodeURIComponent(cleanId)}/move`,
    token.accessToken,
    { destinationId: "archive" },
    "Mail.ReadWrite",
  );
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  const newId = String((res.data as { id?: string })?.id ?? cleanId);
  trackEvent("system.ms_mail_archived", userId, "system", { id: cleanId, new_id: newId });
  await recordAudit({
    actor: { user_id: userId, role: "system" },
    action: "mail.archived",
    resourceType: "mail",
    resourceId: cleanId,
    afterState: { new_id: newId },
  }).catch(() => {});
  return { ok: true, value: { id: newId } };
}

/**
 * Delete (move to Deleted Items) a single Outlook message. Mail.ReadWrite.
 * Graph's DELETE /me/messages/{id} performs a soft-delete to the user's
 * Deleted Items folder — recoverable from the Outlook UI.
 */
export async function deleteMessage(
  userId: string,
  id: string,
): Promise<Result<{ id: string }>> {
  const cleanId = String(id || "").trim();
  if (!cleanId) return { ok: false, code: "invalid_input", message: "id required" };
  const token = await getValidToken(userId);
  if (!token) return { ok: false, code: "not_connected", message: "microsoft_not_connected" };

  const res = await graphDelete(
    `me/messages/${encodeURIComponent(cleanId)}`,
    token.accessToken,
    "Mail.ReadWrite",
  );
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  trackEvent("system.ms_mail_deleted", userId, "system", { id: cleanId });
  await recordAudit({
    actor: { user_id: userId, role: "system" },
    action: "mail.deleted",
    resourceType: "mail",
    resourceId: cleanId,
  }).catch(() => {});
  return { ok: true, value: { id: cleanId } };
}

/**
 * Reply-all to an existing message. Same Graph endpoint as /reply but
 * the /replyAll alternative — preserves the recipient set automatically.
 */
export async function replyAllToMessage(
  userId: string,
  originalMessageId: string,
  input: ReplyInput,
  role = "system",
): Promise<Result<ReplySummary>> {
  if (!originalMessageId || typeof originalMessageId !== "string") {
    return { ok: false, code: "invalid_input", message: "original_message_id_required" };
  }
  if (!input || (!input.bodyHtml && !input.bodyText)) {
    return { ok: false, code: "invalid_input", message: "body_required" };
  }
  const token = await getValidToken(userId);
  if (!token) return { ok: false, code: "not_connected", message: "microsoft_not_connected" };

  const body: Record<string, unknown> = {};
  if (input.bodyHtml && input.bodyHtml.length > 0) {
    body.message = { body: { contentType: "HTML", content: input.bodyHtml } };
  } else {
    body.comment = input.bodyText ?? "";
  }
  const res = await graphPost<unknown>(
    `me/messages/${encodeURIComponent(originalMessageId)}/replyAll`,
    token.accessToken,
    body,
    "Mail.Send",
  );
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  const msMessageId = res.messageId ?? `replyall:${Date.now()}`;
  await recordSendHistory({
    userId,
    msMessageId,
    to: [],
    cc: [],
    bcc: [],
    subject: `(reply-all to ${originalMessageId})`,
    bodyPreview: truncateBodyPreview(input),
    inReplyTo: originalMessageId,
  });
  await auditMailSent({
    userId,
    role,
    action: "mail.replied",
    msMessageId,
    subject: `(reply-all to ${originalMessageId})`,
    to: [],
    inReplyTo: originalMessageId,
  });
  trackEvent("system.ms_mail_reply_all_sent", userId, role, {
    in_reply_to: originalMessageId,
    body_len: truncateBodyPreview(input).length,
  });
  return { ok: true, value: { id: msMessageId } };
}

/**
 * Forward an existing message to one or more new recipients. Mail.Send.
 */
export async function forwardMessage(
  userId: string,
  originalMessageId: string,
  toRecipients: string[],
  input: ReplyInput,
  role = "system",
): Promise<Result<ReplySummary>> {
  if (!originalMessageId || typeof originalMessageId !== "string") {
    return { ok: false, code: "invalid_input", message: "original_message_id_required" };
  }
  const recips = normalizeRecipients(toRecipients);
  if (recips.length === 0) {
    return { ok: false, code: "invalid_input", message: "to_required" };
  }
  if (!input || (!input.bodyHtml && !input.bodyText)) {
    return { ok: false, code: "invalid_input", message: "body_required" };
  }
  const token = await getValidToken(userId);
  if (!token) return { ok: false, code: "not_connected", message: "microsoft_not_connected" };

  // Graph's /forward takes { comment, toRecipients } or message override.
  const body: Record<string, unknown> = {
    toRecipients: recips,
  };
  if (input.bodyHtml && input.bodyHtml.length > 0) {
    body.message = { body: { contentType: "HTML", content: input.bodyHtml } };
  } else {
    body.comment = input.bodyText ?? "";
  }

  const res = await graphPost<unknown>(
    `me/messages/${encodeURIComponent(originalMessageId)}/forward`,
    token.accessToken,
    body,
    "Mail.Send",
  );
  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope,
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }
  const msMessageId = res.messageId ?? `forward:${Date.now()}`;
  await recordSendHistory({
    userId,
    msMessageId,
    to: toRecipients,
    cc: [],
    bcc: [],
    subject: `(forward of ${originalMessageId})`,
    bodyPreview: truncateBodyPreview(input),
    inReplyTo: originalMessageId,
  });
  await auditMailSent({
    userId,
    role,
    action: "mail.replied",
    msMessageId,
    subject: `(forward of ${originalMessageId})`,
    to: toRecipients,
    inReplyTo: originalMessageId,
  });
  trackEvent("system.ms_mail_forward_sent", userId, role, {
    in_reply_to: originalMessageId,
    to_count: toRecipients.length,
    body_len: truncateBodyPreview(input).length,
  });
  return { ok: true, value: { id: msMessageId } };
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  truncateBodyPreview,
  validateSendInput,
  normalizeRecipients,
  normalizeInboxRow,
  BODY_PREVIEW_MAX,
};
