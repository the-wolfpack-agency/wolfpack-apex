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
 

import { getValidToken } from "@/lib/microsoft-graph";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { buildSearchQueryString } from "@/lib/integrations/microsoft-search-keywords";

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
  // Cap input length before any regex passes to bound worst-case time
  // (CodeQL: js/polynomial-redos on the `<[^>]*>` + `\s+` chain).
  const capped = raw.length > 16384 ? raw.slice(0, 16384) : raw;
  const stripped = capped.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
  action: "mail.sent" | "mail.replied" | "mail.drafted";
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

/** Input for createDraft. A subset of SendMailInput: no cc/bcc/save flags. */
export interface DraftMailInput {
  to: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
}

export interface DraftSummary {
  /** Graph message id of the created draft. */
  id: string;
  /** Outlook deep link to open + review the draft, when Graph returns one. */
  webLink?: string;
}

/**
 * Create an Outlook DRAFT via Graph `POST /me/messages`. The message lands in
 * the user's Drafts folder and is NOT sent: this is the safe, reversible action
 * an agent is allowed to take on its owner's behalf (the OGIAM gate escalates an
 * actual send, but a draft has no external effect, so the agent prepares it and
 * the human reviews + sends). Mirrors sendMail's contract exactly: typed Result,
 * never throws, 403 -> scope_missing (Mail.ReadWrite), 429 -> rate_limited,
 * 401 -> not_connected. Emits mail.draft_created + audits "mail.drafted" so the
 * action is never lost to the learning + audit loop.
 */
export async function createDraft(
  userId: string,
  input: DraftMailInput,
  role = "system",
): Promise<Result<DraftSummary>> {
  const invalid = validateSendInput(input as SendMailInput);
  if (invalid) return invalid;

  const token = await getValidToken(userId);
  if (!token) {
    trackEvent("system.ms_mail_draft_failed", userId, role, { reason: "not_connected" });
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  // POST /me/messages creates the message in Drafts (no send). isDraft is true.
  const message = {
    subject: input.subject,
    body: buildMessageBody(input),
    toRecipients: normalizeRecipients(input.to),
  };

  const res = await graphPost<{ id?: string; webLink?: string }>(
    "me/messages",
    token.accessToken,
    message,
    "Mail.ReadWrite",
  );

  if (!res.ok) {
    trackEvent("system.ms_mail_draft_failed", userId, role, {
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

  const id = res.messageId ?? res.data?.id ?? `draft:${Date.now()}`;
  const webLink = typeof res.data?.webLink === "string" ? res.data.webLink : undefined;

  await auditMailSent({
    userId,
    role,
    action: "mail.drafted",
    msMessageId: id,
    subject: input.subject,
    to: input.to ?? [],
  });

  trackEvent("mail.draft_created", userId, role, {
    to_count: (input.to ?? []).length,
    subject_len: input.subject.length,
    body_len: truncateBodyPreview(input).length,
  });

  return { ok: true, value: { id, webLink } };
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
  /** True when Graph reports this as a draft (drafts/sent folders). */
  isDraft?: boolean;
}

/**
 * App-side folder names. We map these to Microsoft Graph well-known
 * folder names so the route layer never has to know about Graph's
 * naming.
 */
export type AppMailFolder = "inbox" | "drafts" | "sent" | "archived";

const APP_FOLDERS: readonly AppMailFolder[] = ["inbox", "drafts", "sent", "archived"];

const FOLDER_TO_GRAPH: Record<AppMailFolder, string> = {
  inbox: "inbox",
  drafts: "drafts",
  sent: "sentitems",
  archived: "archive",
};

export function isAppMailFolder(s: unknown): s is AppMailFolder {
  return typeof s === "string" && (APP_FOLDERS as readonly string[]).includes(s);
}

export function appMailFolderToGraph(folder: AppMailFolder): string {
  return FOLDER_TO_GRAPH[folder];
}

/**
 * Folders where the "unread" concept is meaningful. Drafts and sent
 * messages don't carry a useful isRead state.
 */
const UNREAD_AWARE_FOLDERS: ReadonlySet<AppMailFolder> = new Set(["inbox", "archived"]);

export function folderSupportsUnreadFilter(folder: AppMailFolder): boolean {
  return UNREAD_AWARE_FOLDERS.has(folder);
}

export interface ListInboxOptions {
  /** Default 25, capped at 100 to keep payload sane. */
  top?: number;
  /** Filter on isRead=false (unread only). */
  unreadOnly?: boolean;
  /** OData $skip for paging — cheap because we $orderby receivedDateTime. */
  skip?: number;
  /**
   * Folder. Defaults to "inbox". Accepts either an app folder name
   * ("inbox" | "drafts" | "sent" | "archived") or a raw Graph well-known
   * name ("sentitems", "archive"). Unknown values fall back to "inbox".
   */
  folder?: string;
}

export interface ListFolderMessagesOptions {
  folder: AppMailFolder;
  top?: number;
  skip?: number;
  /**
   * Only meaningful for inbox + archived. Drafts/sent ignore this.
   */
  unreadOnly?: boolean;
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
  isDraft?: boolean | null;
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
    isDraft: Boolean(m.isDraft),
  };
}

/**
 * Resolve any caller-supplied folder string to (a) the app folder
 * canonical name and (b) the Graph well-known name. Accepts both shapes
 * so older callers passing "sentitems" / "archive" keep working.
 */
function resolveFolder(input: string | undefined): {
  appFolder: AppMailFolder;
  graphFolder: string;
} {
  const cleaned = (input ?? "inbox").replace(/[^a-zA-Z0-9_-]/g, "") || "inbox";
  if (isAppMailFolder(cleaned)) {
    return { appFolder: cleaned, graphFolder: FOLDER_TO_GRAPH[cleaned] };
  }
  // Accept Graph well-known names that map to one of our app folders.
  const lower = cleaned.toLowerCase();
  if (lower === "sentitems") return { appFolder: "sent", graphFolder: "sentitems" };
  if (lower === "archive") return { appFolder: "archived", graphFolder: "archive" };
  // Unknown — fall back to inbox to keep the surface safe.
  return { appFolder: "inbox", graphFolder: "inbox" };
}

/**
 * List messages from one of the user's well-known mail folders.
 * Mail.Read scope only.
 *
 * Drafts + sent items don't have a useful "unread" concept, so the
 * `unreadOnly` filter is silently dropped for those folders. Inbox +
 * archived honor it.
 *
 * Folder name mapping (app → Graph well-known):
 *   inbox    → inbox
 *   drafts   → drafts
 *   sent     → sentitems
 *   archived → archive
 */
export async function listFolderMessages(
  userId: string,
  opts: ListFolderMessagesOptions,
): Promise<Result<ListInboxPage>> {
  const { appFolder, graphFolder } = resolveFolder(opts.folder);
  const top = Math.min(Math.max(Number.isFinite(opts.top) ? Number(opts.top) : 25, 1), 100);
  const skip = Math.max(Number.isFinite(opts.skip) ? Number(opts.skip) : 0, 0);
  const honorUnread = Boolean(opts.unreadOnly) && folderSupportsUnreadFilter(appFolder);

  const token = await getValidToken(userId);
  if (!token) {
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const select =
    "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance,webLink,isDraft";
  const order = "receivedDateTime desc";
  const filter = honorUnread ? "isRead eq false" : "";
  const params: string[] = [
    `$top=${top}`,
    `$skip=${skip}`,
    `$orderby=${encodeURIComponent(order)}`,
    `$select=${encodeURIComponent(select)}`,
    `$count=true`,
  ];
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);

  const path = `me/mailFolders/${graphFolder}/messages?${params.join("&")}`;
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
    folder: appFolder,
    graph_folder: graphFolder,
    count: messages.length,
    unread_only: honorUnread,
    top,
    skip,
  });

  return {
    ok: true,
    value: {
      messages,
      nextSkip,
      unreadCount: honorUnread ? totalCount : undefined,
    },
  };
}

/**
 * Backwards-compatible wrapper around `listFolderMessages`. Defaults to
 * the inbox folder when none is passed. Keep this so older callers /
 * tests that use `listInbox` keep working unchanged.
 */
export async function listInbox(
  userId: string,
  opts: ListInboxOptions = {},
): Promise<Result<ListInboxPage>> {
  const { appFolder } = resolveFolder(opts.folder);
  return listFolderMessages(userId, {
    folder: appFolder,
    top: opts.top,
    skip: opts.skip,
    unreadOnly: opts.unreadOnly,
  });
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
// Search (read-only) — used by the assistant context resolver.
//
// Wraps Graph's POST /search/query for entityTypes=["message"] so the
// assistant can find email threads relevant to a user question. Same scope
// as the rest of the read path (`Mail.Read`) — no separate consent needed.
// Per-user delegated token (Graph automatically scopes /search to the
// caller's mailbox).
// ---------------------------------------------------------------------------

export interface EmailThreadHit {
  id: string;
  subject: string;
  from: string;
  received_at: string;  // ISO datetime
  snippet: string;      // <= 300 char preview
  url?: string;         // webLink deep link
  source_kind: "email";
}

export interface SearchMessagesOptions {
  query: string;
  /** Cap on returned hits. Default 5, max 25. */
  topN?: number;
}

export interface SearchMessagesValue {
  hits: EmailThreadHit[];
  total: number;
  took_ms: number;
  /**
   * Final keyword string sent to Graph as `query.queryString`. Surfaced so
   * the diagnostic page (and integration tests) can assert exactly what
   * was searched. Often differs from the user's verbatim question because
   * `buildSearchQueryString` strips natural-language filler.
   */
  query_string_sent: string;
}

const EMAIL_SNIPPET_MAX = 300;
const EMAIL_DEFAULT_TOP_N = 5;
const EMAIL_TOP_N_CAP = 25;

interface RawSearchHitMessage {
  hitId?: string;
  rank?: number;
  summary?: string;
  resource?: {
    id?: string;
    subject?: string;
    bodyPreview?: string;
    from?: RawRecipient | null;
    sender?: RawRecipient | null;
    receivedDateTime?: string;
    webLink?: string;
    "@odata.type"?: string;
  };
}

interface RawSearchResponseMessages {
  value?: Array<{
    hitsContainers?: Array<{
      hits?: RawSearchHitMessage[];
      total?: number;
    }>;
  }>;
}

function clipMailSnippet(s: string | null | undefined): string {
  if (!s) return "";
  const stripped = String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length <= EMAIL_SNIPPET_MAX
    ? stripped
    : stripped.slice(0, EMAIL_SNIPPET_MAX - 1).trim() + "…";
}

function normalizeMessageHit(raw: RawSearchHitMessage): EmailThreadHit | null {
  const r = raw?.resource;
  if (!r || !r.id) return null;
  const fromRecord = r.from?.emailAddress || r.sender?.emailAddress || {};
  const fromLabel =
    (fromRecord.name && fromRecord.name.trim()) ||
    (fromRecord.address && fromRecord.address.trim()) ||
    "(unknown sender)";
  const snippet = clipMailSnippet(raw.summary || r.bodyPreview || "");
  const hit: EmailThreadHit = {
    id: r.id,
    subject: r.subject || "(no subject)",
    from: fromLabel,
    received_at: r.receivedDateTime || "",
    snippet,
    source_kind: "email",
  };
  if (r.webLink) hit.url = r.webLink;
  return hit;
}

/**
 * Keyword search across the calling user's mailbox via Graph's
 * `/search/query` with entityTypes=["message"]. Mail.Read scope.
 *
 * The query string is passed through verbatim; the resolver chooses what to
 * pass (typically the raw question, sometimes augmented with extracted noun
 * phrases). Graph's KQL handles tokenization + relevance.
 *
 * Returns a typed Result. On 403 returns `scope_missing` with `Mail.Read`
 * so the UI can prompt for a Microsoft 365 reconnect.
 *
 * Privacy: per-user delegated token only — never service principal.
 */
export async function searchMessages(
  userId: string,
  opts: SearchMessagesOptions,
): Promise<Result<SearchMessagesValue>> {
  const t0 = Date.now();
  const q = String(opts?.query ?? "").trim();
  if (!q) return { ok: false, code: "invalid_input", message: "query_required" };

  const token = await getValidToken(userId);
  if (!token) {
    return { ok: false, code: "not_connected", message: "microsoft_not_connected" };
  }

  const requested = Number.isFinite(opts.topN) ? Number(opts.topN) : EMAIL_DEFAULT_TOP_N;
  const topN = Math.min(Math.max(requested, 1), EMAIL_TOP_N_CAP);

  /* Microsoft's /search/query is keyword/phrase based; passing a verbatim
     user question drops too many noise words and Graph returns 0 hits even
     when the message exists. Extract the load-bearing tokens first so
     Graph can match. See microsoft-search-keywords.ts. */
  const queryString = buildSearchQueryString(q);

  const body = {
    requests: [
      {
        entityTypes: ["message"],
        query: { queryString },
        from: 0,
        size: topN,
      },
    ],
  };

  const res = await graphPost<RawSearchResponseMessages>(
    "search/query",
    token.accessToken,
    body,
    "Mail.Read",
  );

  if (!res.ok) {
    return {
      ok: false,
      code: res.code,
      scope: res.scope ?? (res.code === "scope_missing" ? "Mail.Read" : undefined),
      retryAfter: res.retryAfter,
      status: res.status,
      message: res.message,
    };
  }

  const containers = res.data?.value?.[0]?.hitsContainers ?? [];
  const rawHits: RawSearchHitMessage[] = [];
  let total = 0;
  for (const c of containers) {
    if (Array.isArray(c.hits)) rawHits.push(...c.hits);
    if (typeof c.total === "number") total += c.total;
  }
  const hits = rawHits
    .map(normalizeMessageHit)
    .filter((h): h is EmailThreadHit => h !== null)
    .slice(0, topN);
  if (!total) total = hits.length;

  return {
    ok: true,
    value: { hits, total, took_ms: Date.now() - t0, query_string_sent: queryString },
  };
}

/**
 * Track an email-lookup failure as a typed analytics event. Mirrors the
 * SharePoint / Project / Calendar failure helpers so the assistant
 * dashboard can render all surfaces uniformly.
 */
export function trackEmailLookupFailure(
  userId: string,
  role: string,
  error: MailErrorResult,
): void {
  trackEvent("assistant.email_lookup_failed", userId, role, {
    status: error.status ?? 0,
    scope_missing: error.code === "scope_missing",
    code: error.code,
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  truncateBodyPreview,
  validateSendInput,
  normalizeRecipients,
  normalizeInboxRow,
  resolveFolder,
  normalizeMessageHit,
  clipMailSnippet,
  BODY_PREVIEW_MAX,
  FOLDER_TO_GRAPH,
  EMAIL_SNIPPET_MAX,
  EMAIL_DEFAULT_TOP_N,
  EMAIL_TOP_N_CAP,
};
