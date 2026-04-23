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
  scope: "Chat.Read";
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
