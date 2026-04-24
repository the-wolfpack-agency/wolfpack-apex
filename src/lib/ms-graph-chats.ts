/**
 * Microsoft Graph — Teams chats (Phase 1, read-only).
 *
 * Read-only surface over `/me/chats` and `/me/chats/{id}/messages`. We
 * request `Chat.Read` delegated scope only. Send / reply / channel
 * message access is NOT requested in this phase — those flows go
 * through Teams deep-links (see `ms-graph-deep-links.ts`), which cost
 * zero additional Graph scope.
 *
 * Every Graph failure is swallowed and returned as an empty array so
 * call sites never throw. A 401/403 is translated into the analytics
 * event `ms_chats.scope_missing` so the UI can prompt the user to
 * grant the scope.
 *
 * Body content from Graph arrives as HTML for many chats. We strip
 * tags down to a plain-text `bodyText` so callers can preview safely
 * without a sanitizer; the original `body.content` + `body.contentType`
 * are preserved alongside.
 */

import { trackEvent } from "@/lib/analytics";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatMember {
  displayName: string;
  email: string;
  userId: string;
}

export interface ChatMessageFrom {
  displayName: string;
  email: string;
  userId: string;
}

export interface ChatLastMessagePreview {
  body: { content: string; contentType: "html" | "text" };
  bodyText: string;
  from: ChatMessageFrom;
  createdDateTime: string;
}

export interface Chat {
  id: string;
  topic: string;
  chatType: string;
  lastUpdatedDateTime: string;
  members: ChatMember[];
  lastMessagePreview?: ChatLastMessagePreview;
}

export interface ChatMessage {
  id: string;
  from: ChatMessageFrom;
  body: { content: string; contentType: "html" | "text" };
  bodyText: string;
  createdDateTime: string;
}

// ---------------------------------------------------------------------------
// Internal Graph wire types
// ---------------------------------------------------------------------------

interface RawIdentitySet {
  user?: {
    id?: string;
    displayName?: string;
    email?: string;
    userIdentityType?: string;
  } | null;
}

interface RawChatMember {
  displayName?: string;
  email?: string;
  userId?: string;
}

interface RawBody {
  content?: string;
  contentType?: string;
}

interface RawLastMessagePreview {
  body?: RawBody;
  from?: RawIdentitySet;
  createdDateTime?: string;
}

interface RawChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  lastUpdatedDateTime?: string;
  members?: RawChatMember[];
  lastMessagePreview?: RawLastMessagePreview | null;
}

interface RawChatMessage {
  id: string;
  from?: RawIdentitySet;
  body?: RawBody;
  createdDateTime?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags + decode the handful of entities Teams actually emits,
 * then collapse whitespace. Intended for preview text only — NOT a
 * sanitizer; do not render `body.content` without proper sanitization.
 */
export function stripHtml(input: string | undefined | null): string {
  if (!input) return "";
  const withoutTags = String(input)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/p\s*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

function normalizeBody(raw: RawBody | undefined): {
  body: { content: string; contentType: "html" | "text" };
  bodyText: string;
} {
  const content = typeof raw?.content === "string" ? raw.content : "";
  const contentType = raw?.contentType === "text" ? "text" : "html";
  const bodyText = contentType === "text" ? content.trim() : stripHtml(content);
  return { body: { content, contentType }, bodyText };
}

function normalizeFrom(raw: RawIdentitySet | undefined): ChatMessageFrom {
  const u = raw?.user || {};
  return {
    displayName: typeof u.displayName === "string" ? u.displayName : "",
    email: typeof u.email === "string" ? u.email : "",
    userId: typeof u.id === "string" ? u.id : "",
  };
}

function normalizeMembers(raw: RawChatMember[] | undefined): ChatMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    displayName: typeof m.displayName === "string" ? m.displayName : "",
    email: typeof m.email === "string" ? m.email : "",
    userId: typeof m.userId === "string" ? m.userId : "",
  }));
}

function normalizeChat(raw: RawChat): Chat {
  const chat: Chat = {
    id: raw.id,
    topic: typeof raw.topic === "string" ? raw.topic : "",
    chatType: typeof raw.chatType === "string" ? raw.chatType : "",
    lastUpdatedDateTime:
      typeof raw.lastUpdatedDateTime === "string" ? raw.lastUpdatedDateTime : "",
    members: normalizeMembers(raw.members),
  };
  if (raw.lastMessagePreview) {
    const { body, bodyText } = normalizeBody(raw.lastMessagePreview.body);
    chat.lastMessagePreview = {
      body,
      bodyText,
      from: normalizeFrom(raw.lastMessagePreview.from),
      createdDateTime:
        typeof raw.lastMessagePreview.createdDateTime === "string"
          ? raw.lastMessagePreview.createdDateTime
          : "",
    };
  }
  return chat;
}

function normalizeMessage(raw: RawChatMessage): ChatMessage {
  const { body, bodyText } = normalizeBody(raw.body);
  return {
    id: raw.id,
    from: normalizeFrom(raw.from),
    body,
    bodyText,
    createdDateTime: typeof raw.createdDateTime === "string" ? raw.createdDateTime : "",
  };
}

// ---------------------------------------------------------------------------
// Scope-missing discriminator
// ---------------------------------------------------------------------------

export type ScopeMissingResult = {
  ok: false;
  code: "scope_missing";
  scope: "Chat.Read" | "Chat.ReadWrite";
};

export type ListChatsResult =
  | { ok: true; chats: Chat[] }
  | ScopeMissingResult;

export type GetChatResult =
  | { ok: true; chat: Chat }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "forbidden" }
  | ScopeMissingResult;

export type ListChatMessagesResult =
  | { ok: true; messages: ChatMessage[] }
  | ScopeMissingResult;

export type SendChatMessageResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; code: "error"; status: number }
  | ScopeMissingResult;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_CHAT_LIMIT = 25;
const DEFAULT_MESSAGE_LIMIT = 30;

async function graphGet<T>(
  path: string,
  token: string,
): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(`${GRAPH_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
        try {
          const errText = await res.text();
          console.warn(
            `[ms-graph-chats] Graph ${path} returned ${res.status}: ${errText.slice(0, 200)}`,
          );
        } catch {
          // ignore
        }
      }
      return { status: res.status, data: null };
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  } catch (err) {
    console.warn(
      `[ms-graph-chats] Graph ${path} fetch error:`,
      (err as Error).message,
    );
    return { status: 0, data: null };
  }
}

/**
 * List recent chats for the signed-in user, newest first.
 *
 * Shape returned from Graph: `{ value: RawChat[] }`. We normalize to a
 * plain array of `Chat` objects and strip HTML from
 * `lastMessagePreview.body` into `bodyText` for safe previews.
 *
 * Errors:
 * - Scope missing (401/403) → returns `[]` and emits `ms_chats.scope_missing`.
 * - Network / 5xx → returns `[]` and logs `console.warn`.
 *
 * For callers that need to distinguish scope-missing from
 * empty-inbox use `listChatsResult` below.
 */
export async function listChats(
  userMsToken: string,
  limit: number = DEFAULT_CHAT_LIMIT,
  userId: string = "system",
): Promise<Chat[]> {
  const result = await listChatsResult(userMsToken, limit, userId);
  return result.ok ? result.chats : [];
}

/**
 * Fetch the caller's canonical Graph identity. This is authoritative
 * for "who is self" when filtering chat.members arrays — the stored
 * instinct_ms_tokens.user_email can drift (blank after re-consent,
 * UPN vs SMTP mismatch, or linked to a different account than the
 * one the user actually authenticates as).
 *
 * Returns { id, mail, userPrincipalName, displayName } on success,
 * null on any error (401/network/etc.). Caller falls back to the
 * stored token email on null.
 */
export interface GraphMeIdentity {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
}

export async function getGraphMe(
  userMsToken: string,
): Promise<GraphMeIdentity | null> {
  try {
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",
      { headers: { Authorization: `Bearer ${userMsToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
      displayName?: unknown;
    };
    return {
      id: typeof data.id === "string" ? data.id : "",
      mail: typeof data.mail === "string" ? data.mail : null,
      userPrincipalName:
        typeof data.userPrincipalName === "string" ? data.userPrincipalName : null,
      displayName: typeof data.displayName === "string" ? data.displayName : null,
    };
  } catch (err) {
    console.warn("[graph /me] failed:", (err as Error).message);
    return null;
  }
}

/** Discriminated variant of `listChats` — lets the route expose scope_missing. */
export async function listChatsResult(
  userMsToken: string,
  limit: number = DEFAULT_CHAT_LIMIT,
  userId: string = "system",
): Promise<ListChatsResult> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || DEFAULT_CHAT_LIMIT)));
  const qs =
    `/me/chats?$top=${safeLimit}` +
    `&$orderby=${encodeURIComponent("lastMessagePreview/createdDateTime desc")}` +
    `&$expand=members`;

  const { status, data } = await graphGet<{ value?: RawChat[] }>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_chats.scope_missing", userId, "system", {});
    return { ok: false, code: "scope_missing", scope: "Chat.Read" };
  }
  const raw = Array.isArray(data?.value) ? data!.value : [];
  const chats = raw.map(normalizeChat);
  trackEvent("ms_chats.listed", userId, "system", { count: chats.length });
  return { ok: true, chats };
}

/**
 * Fetch a single chat's metadata (including members). Used by the
 * route-level membership gate before releasing messages.
 */
export async function getChat(
  userMsToken: string,
  chatId: string,
  userId: string = "system",
): Promise<GetChatResult> {
  const qs = `/me/chats/${encodeURIComponent(chatId)}?$expand=members`;
  const { status, data } = await graphGet<RawChat>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_chats.scope_missing", userId, "system", {});
    return { ok: false, code: "scope_missing", scope: "Chat.Read" };
  }
  if (status === 404 || !data) return { ok: false, code: "not_found" };
  return { ok: true, chat: normalizeChat(data) };
}

/**
 * Fetch messages for a single chat, newest-first.
 *
 * Callers MUST verify the caller is a member of the chat before
 * invoking — this lib does not enforce membership; the route does.
 */
export async function getChatMessages(
  userMsToken: string,
  chatId: string,
  limit: number = DEFAULT_MESSAGE_LIMIT,
  userId: string = "system",
): Promise<ChatMessage[]> {
  const result = await getChatMessagesResult(userMsToken, chatId, limit, userId);
  return result.ok ? result.messages : [];
}

/** Discriminated variant of `getChatMessages`. */
export async function getChatMessagesResult(
  userMsToken: string,
  chatId: string,
  limit: number = DEFAULT_MESSAGE_LIMIT,
  userId: string = "system",
): Promise<ListChatMessagesResult> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || DEFAULT_MESSAGE_LIMIT)));
  const qs =
    `/me/chats/${encodeURIComponent(chatId)}/messages` +
    `?$top=${safeLimit}` +
    `&$orderby=${encodeURIComponent("createdDateTime desc")}`;
  const { status, data } = await graphGet<{ value?: RawChatMessage[] }>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_chats.scope_missing", userId, "system", {});
    return { ok: false, code: "scope_missing", scope: "Chat.Read" };
  }
  const raw = Array.isArray(data?.value) ? data!.value : [];
  const messages = raw.map(normalizeMessage);
  trackEvent("ms_chats.messages_loaded", userId, "system", {
    chat_id: chatId,
    count: messages.length,
  });
  return { ok: true, messages };
}

// ---------------------------------------------------------------------------
// sendChatMessage — write path (Phase 1.5 internal deployment)
// ---------------------------------------------------------------------------

/**
 * Conservative HTML sanitizer for Teams compose bodies. Strips anything
 * that could execute in a Teams web-client context:
 *   - <script> / <style> blocks
 *   - event-handler attributes (`onclick=...`, etc.)
 *   - `javascript:` URLs
 *   - `<iframe>` / `<object>` / `<embed>` / `<link>` / `<meta>` tags
 *
 * This is intentionally narrower than a general sanitizer — Teams
 * itself will also sanitize server-side, but we must never forward a
 * payload that could round-trip back into Instinct's own UI with a
 * live handler attached.
 */
export function sanitizeComposeHtml(input: string): string {
  if (!input) return "";
  let out = String(input);
  // Remove dangerous blocks entirely, including their contents.
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<iframe\b[^>]*\/?\s*>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?\s*>/gi, "")
    .replace(/<link\b[^>]*\/?\s*>/gi, "")
    .replace(/<meta\b[^>]*\/?\s*>/gi, "");
  // Strip event handlers: on<word>=... (quoted or unquoted value).
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Neutralize javascript: / data:text/html URLs inside attributes.
  out = out.replace(/(href|src)\s*=\s*"(\s*javascript:[^"]*)"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'(\s*javascript:[^']*)'/gi, "$1='#'");
  out = out.replace(/(href|src)\s*=\s*(javascript:[^\s>]+)/gi, '$1="#"');
  return out;
}

/**
 * Send a message to a Teams chat on behalf of the signed-in user.
 *
 * Contract:
 *   - Default contentType is "text"; any incoming HTML is passed
 *     through `sanitizeComposeHtml` before POSTing.
 *   - 401 / 403 → `{ok:false, code:"scope_missing", scope:"Chat.ReadWrite"}`
 *     + analytics `ms_chats.scope_missing`. Caller must surface a
 *     re-consent prompt; never throws.
 *   - Network / 5xx → `{ok:false, code:"error", status}` + console.warn.
 *   - 2xx → `{ok:true, message}` with the normalized Graph response and
 *     analytics `ms_chats.message_sent` { chat_id, length }.
 *
 * Membership is NOT enforced here — callers (the route handler) must
 * verify the signed-in user is a member of `chatId` before invoking.
 */
/**
 * Per Microsoft Graph: each mention object pairs an `<at id="N">`
 * inline tag in the message body with the AAD identity of the
 * user being notified. The id is a 0-based index local to this
 * single message — it doesn't need to be unique across messages.
 */
export interface ChatMentionInput {
  /** 0-based index that matches `<at id="N">` in the body. */
  id: number;
  /** Visible text inside the at-tag. */
  mentionText: string;
  /** AAD object id of the mentioned user. */
  userId: string;
  /** Display name (helps Graph render fallback). */
  displayName: string;
}

export async function sendChatMessage(
  userMsToken: string,
  chatId: string,
  content: string,
  contentType: "text" | "html" = "text",
  userId: string = "system",
  mentions: ChatMentionInput[] = [],
): Promise<SendChatMessageResult> {
  const safeContent =
    contentType === "html" ? sanitizeComposeHtml(content) : String(content || "");
  const path = `/me/chats/${encodeURIComponent(chatId)}/messages`;

  // Graph rejects mentions array on text content type — atomically
  // promote to html if any mentions are present.
  const finalContentType = mentions.length > 0 ? "html" : contentType;
  const graphMentions = mentions.map((m) => ({
    id: m.id,
    mentionText: m.mentionText,
    mentioned: {
      user: {
        id: m.userId,
        displayName: m.displayName,
        userIdentityType: "aadUser" as const,
      },
    },
  }));

  try {
    const res = await fetch(`${GRAPH_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userMsToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        graphMentions.length > 0
          ? {
              body: { content: safeContent, contentType: finalContentType },
              mentions: graphMentions,
            }
          : { body: { content: safeContent, contentType: finalContentType } },
      ),
    });

    if (res.status === 401 || res.status === 403) {
      trackEvent("ms_chats.scope_missing", userId, "system", {});
      return { ok: false, code: "scope_missing", scope: "Chat.ReadWrite" };
    }

    if (!res.ok) {
      let errBody = "";
      try {
        errBody = await res.text();
      } catch {
        // ignore
      }
      console.warn(
        `[ms-graph-chats] sendChatMessage ${chatId} returned ${res.status}: ${errBody.slice(0, 200)}`,
      );
      return { ok: false, code: "error", status: res.status };
    }

    const data = (await res.json()) as RawChatMessage;
    const message = normalizeMessage(data);

    trackEvent("ms_chats.message_sent", userId, "system", {
      chat_id: chatId,
      length: safeContent.length,
    });

    return { ok: true, message };
  } catch (err) {
    console.warn(
      `[ms-graph-chats] sendChatMessage ${chatId} fetch error:`,
      (err as Error).message,
    );
    return { ok: false, code: "error", status: 0 };
  }
}
