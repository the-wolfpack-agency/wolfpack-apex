/**
 * Microsoft Teams (personal chat) integration.
 *
 * Builds on the existing `@/lib/microsoft-graph` OAuth + token storage.
 * Dashboard + Assistant RAG reads are served from the local Postgres cache
 * (instinct_teams_chats + instinct_teams_messages). Graph remains the
 * source of truth; `syncAllForUser` walks chats + recent messages and
 * upserts on ON CONFLICT DO UPDATE so it is idempotent.
 *
 * Graph surface:
 *   GET /me/chats?$top={n}
 *   GET /me/chats/{chatId}/messages?$top={n}&$orderby=createdDateTime desc
 *
 * Rate limits: Graph 429 Retry-After is honored exactly once per call
 * (capped at 60s). 403 `scope_missing` bubbles up as a typed result so
 * callers can surface "reconnect with new scopes" UX.
 *
 * RAG hookup: every synced message is also fed into the Assistant RAG
 * index via `@/lib/learning/ms-content-ingest`. Indexing failures are
 * caught + analytics-emitted; they never block the sync.
 */
 

import { getValidToken } from "@/lib/microsoft-graph";
import { htmlToText } from "@/lib/html-sanitize";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { indexTeamsMessage } from "@/lib/learning/ms-content-ingest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatType = "oneOnOne" | "group" | "meeting";

export interface TeamsChat {
  id: string; // local UUID
  msChatId: string; // Graph id
  userId: string;
  chatType: ChatType;
  topic: string | null;
  participants: TeamsParticipant[];
  lastUpdatedAt: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface TeamsParticipant {
  id?: string;
  displayName: string;
  email?: string;
}

export interface TeamsMessageSender {
  id?: string;
  displayName: string;
  email?: string;
}

export interface TeamsMessage {
  id: string; // local UUID
  msMessageId: string;
  chatId: string; // local chat UUID
  userId: string;
  sender: TeamsMessageSender;
  body: string; // plaintext
  bodyHtml: string | null;
  importance: "low" | "normal" | "high";
  createdAt: string;
  updatedAt: string | null;
  syncedAt: string;
  payload: Record<string, unknown>;
}

export interface ListChatsOpts {
  top?: number;
  cursor?: string; // Graph @odata.nextLink URL
}

export interface ListMessagesOpts {
  top?: number;
  cursor?: string; // Graph @odata.nextLink URL
}

export interface SyncOpts {
  messagesPerChat?: number;
}

export interface SyncResult {
  chatCount: number;
  messageCount: number;
  durationMs: number;
}

export type ScopeMissingError = {
  ok: false;
  code: "scope_missing";
  scope: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TeamsChatError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "TeamsChatError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_RETRY_AFTER_MS = 60 * 1000; // cap 60s per pause

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new TeamsChatError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

/**
 * Low-level Graph GET with 429 Retry-After handling (retry once, cap 60s).
 * Propagates 403 as TeamsChatError(403, ...) so callers can translate to
 * scope_missing.
 */
async function graphGet<T = unknown>(endpoint: string, accessToken: string): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const res = await fetch(url, { method: "GET", headers });

  if (res.status === 429) {
    const raRaw = parseInt(res.headers.get("Retry-After") || "0", 10);
    const raMs = Math.min(
      Number.isFinite(raRaw) && raRaw > 0 ? raRaw * 1000 : 1000,
      MAX_RETRY_AFTER_MS,
    );
    await sleep(raMs);
    const retry = await fetch(url, { method: "GET", headers });
    if (!retry.ok) {
      throw new TeamsChatError(
        retry.status,
        `Graph GET ${endpoint} failed after retry: ${retry.status}`,
        Math.ceil(raMs / 1000),
      );
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new TeamsChatError(res.status, `Graph GET ${endpoint} failed: ${res.status} ${text}`);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// HTML → plaintext (regex-based, no new deps)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags + decode the most common entities. Small regex-based
 * helper — no dependency. Good enough for Teams message bodies where we
 * only need searchable text, not semantic preservation.
 */
export function htmlToPlaintext(html: string | null | undefined): string {
  if (!html) return "";
  // Parser-based HTML→text via @/lib/html-sanitize. Replaces a regex
  // strip flagged by CodeQL for double-escaping +
  // incomplete-multi-character-sanitization +
  // js/polynomial-redos / js/bad-tag-filter on the entity decoder.
  let s = htmlToText(String(html));
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphChat {
  id: string;
  chatType?: string;
  topic?: string | null;
  lastUpdatedDateTime?: string | null;
  members?: {
    id?: string;
    displayName?: string;
    email?: string;
  }[];
  "@odata.etag"?: string;
}

interface GraphMessage {
  id: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  importance?: string;
  from?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  body?: {
    content?: string;
    contentType?: string;
  };
  [k: string]: unknown;
}

function normalizeParticipants(members: GraphChat["members"]): TeamsParticipant[] {
  if (!members) return [];
  return members
    .filter((m) => m && (m.displayName || m.email))
    .map((m) => ({
      id: m.id,
      displayName: m.displayName || m.email || "Unknown",
      email: m.email,
    }));
}

function coerceChatType(t: string | undefined): ChatType {
  if (t === "group" || t === "meeting") return t;
  return "oneOnOne";
}

function coerceImportance(i: string | undefined): "low" | "normal" | "high" {
  const v = (i || "normal").toLowerCase();
  if (v === "low" || v === "high") return v;
  return "normal";
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertChat(userId: string, g: GraphChat): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_teams_chats
       (user_id, ms_chat_id, chat_type, topic, participants, last_updated_at, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
     ON CONFLICT (user_id, ms_chat_id) DO UPDATE SET
       chat_type = EXCLUDED.chat_type,
       topic = EXCLUDED.topic,
       participants = EXCLUDED.participants,
       last_updated_at = EXCLUDED.last_updated_at,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [
      userId,
      g.id,
      coerceChatType(g.chatType),
      g.topic ?? null,
      JSON.stringify(normalizeParticipants(g.members)),
      g.lastUpdatedDateTime ? new Date(g.lastUpdatedDateTime).toISOString() : null,
      g["@odata.etag"] ?? null,
    ],
  );
  return rows[0].id;
}

async function upsertMessage(
  userId: string,
  chatUuid: string,
  g: GraphMessage,
): Promise<string> {
  const bodyHtml = g.body?.contentType === "html" ? g.body?.content ?? null : null;
  const bodyRaw = g.body?.content ?? "";
  const bodyPlain = g.body?.contentType === "html" ? htmlToPlaintext(bodyRaw) : bodyRaw;

  const sender: TeamsMessageSender = {
    id: g.from?.user?.id,
    displayName: g.from?.user?.displayName || "Unknown",
  };

  const createdAt = g.createdDateTime
    ? new Date(g.createdDateTime).toISOString()
    : new Date().toISOString();
  const updatedAt = g.lastModifiedDateTime
    ? new Date(g.lastModifiedDateTime).toISOString()
    : null;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_teams_messages
       (user_id, ms_message_id, chat_id, sender, body, body_html, importance,
        created_at, updated_at, synced_at, payload)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, now(), $10::jsonb)
     ON CONFLICT (user_id, ms_message_id) DO UPDATE SET
       chat_id = EXCLUDED.chat_id,
       sender = EXCLUDED.sender,
       body = EXCLUDED.body,
       body_html = EXCLUDED.body_html,
       importance = EXCLUDED.importance,
       updated_at = EXCLUDED.updated_at,
       synced_at = now(),
       payload = EXCLUDED.payload
     RETURNING id`,
    [
      userId,
      g.id,
      chatUuid,
      JSON.stringify(sender),
      bodyPlain,
      bodyHtml,
      coerceImportance(g.importance),
      createdAt,
      updatedAt,
      JSON.stringify(g),
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List the caller's Teams chats. Reads directly from Graph. Returns a
 * cursor (Graph @odata.nextLink URL) when there is another page.
 */
export async function listChats(
  userId: string,
  opts: ListChatsOpts = {},
): Promise<{ chats: GraphChat[]; nextCursor?: string }> {
  const token = await resolveToken(userId);
  const top = Math.min(Math.max(opts.top ?? 50, 1), 50);
  const endpoint = opts.cursor ?? `me/chats?$top=${top}`;
  const res = await graphGet<{ value?: GraphChat[]; "@odata.nextLink"?: string }>(
    endpoint,
    token,
  );
  return {
    chats: res.value ?? [],
    nextCursor: res["@odata.nextLink"],
  };
}

/**
 * List recent messages in a Teams chat. Returns Graph's raw shape so
 * sync + caller code can choose its own normalization.
 */
export async function listMessages(
  userId: string,
  chatId: string,
  opts: ListMessagesOpts = {},
): Promise<{ messages: GraphMessage[]; nextCursor?: string }> {
  const token = await resolveToken(userId);
  const top = Math.min(Math.max(opts.top ?? 50, 1), 50);
  const endpoint =
    opts.cursor ??
    `me/chats/${encodeURIComponent(chatId)}/messages?$top=${top}&$orderby=createdDateTime desc`;
  const res = await graphGet<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(
    endpoint,
    token,
  );
  return {
    messages: res.value ?? [],
    nextCursor: res["@odata.nextLink"],
  };
}

/**
 * Full sync — paginates chats + pulls the last N messages for each and
 * upserts them into the local cache. Every message is additionally fed
 * into the Assistant RAG index. Indexing failures do NOT block the sync.
 */
export async function syncAllForUser(
  userId: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const start = Date.now();
  const messagesPerChat = Math.min(Math.max(opts.messagesPerChat ?? 50, 1), 200);

  try {
    let chatCount = 0;
    let messageCount = 0;

    // Paginate chats via Graph @odata.nextLink. Hard cap 50 pages / 2500 chats.
    let chatCursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const { chats, nextCursor } = await listChats(userId, {
        top: 50,
        cursor: chatCursor,
      });
      for (const g of chats) {
        const chatUuid = await upsertChat(userId, g);
        chatCount++;

        // Last N messages per chat — single page is sufficient.
        const { messages } = await listMessages(userId, g.id, { top: messagesPerChat });
        for (const m of messages) {
          await upsertMessage(userId, chatUuid, m);
          messageCount++;

          // Best-effort Assistant RAG ingest.
          try {
            const bodyPlain =
              m.body?.contentType === "html"
                ? htmlToPlaintext(m.body?.content ?? "")
                : m.body?.content ?? "";
            await indexTeamsMessage(userId, {
              msMessageId: m.id,
              chatId: chatUuid,
              msChatId: g.id,
              chatTopic: g.topic ?? null,
              sender: m.from?.user?.displayName || "Unknown",
              body: bodyPlain,
              createdAt: m.createdDateTime
                ? new Date(m.createdDateTime).toISOString()
                : new Date().toISOString(),
            });
          } catch (ingestErr) {
            trackEvent("system.ms_teams_sync_indexing_failed", userId, "system", {
              ms_message_id: m.id,
              error: (ingestErr as Error).message,
            });
            // Never block sync.
          }
        }
      }
      chatCursor = nextCursor;
      if (!chatCursor) break;
    }

    const durationMs = Date.now() - start;
    trackEvent("system.ms_teams_chats_synced", userId, "system", {
      user_id: userId,
      chat_count: chatCount,
      duration_ms: durationMs,
    });
    trackEvent("system.ms_teams_messages_synced", userId, "system", {
      user_id: userId,
      message_count: messageCount,
      duration_ms: durationMs,
    });

    return { chatCount, messageCount, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const status = err instanceof TeamsChatError ? err.status : 0;
    trackEvent("system.ms_teams_sync_failed", userId, "system", {
      user_id: userId,
      error: (err as Error).message,
      http_status: status,
      duration_ms: durationMs,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scope-missing helper — translates TeamsChatError(403) into
// { ok:false, code:"scope_missing" } so routes can return structured errors.
// ---------------------------------------------------------------------------

export function asScopeMissing(
  err: unknown,
  scope: string,
): ScopeMissingError | null {
  if (err instanceof TeamsChatError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache read helpers
// ---------------------------------------------------------------------------

export interface ListCachedChatsOpts {
  limit?: number;
  cursor?: string; // chat UUID
}

export async function listCachedChats(
  userId: string,
  opts: ListCachedChatsOpts = {},
): Promise<{ chats: TeamsChat[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  const conds: string[] = ["user_id = $1"];
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_chat_id, chat_type, topic, participants,
            last_updated_at, etag, synced_at
       FROM instinct_teams_chats
       WHERE ${conds.join(" AND ")}
       ORDER BY last_updated_at DESC NULLS LAST, id ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const chats: TeamsChat[] = taken.map(rowToChat);
  const nextCursor = hasMore ? chats[chats.length - 1].id : null;
  return { chats, nextCursor };
}

export async function getCachedChatById(
  userId: string,
  localId: string,
): Promise<TeamsChat | null> {
  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_chat_id, chat_type, topic, participants,
            last_updated_at, etag, synced_at
       FROM instinct_teams_chats
       WHERE user_id = $1 AND id = $2
       LIMIT 1`,
    [userId, localId],
  );
  if (rows.length === 0) return null;
  return rowToChat(rows[0]);
}

export interface ListCachedMessagesOpts {
  limit?: number;
  cursor?: string; // message UUID offset (pagination)
  search?: string;
}

export async function listCachedMessages(
  userId: string,
  chatLocalId: string,
  opts: ListCachedMessagesOpts = {},
): Promise<{ messages: TeamsMessage[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId, chatLocalId];
  const conds: string[] = ["user_id = $1", "chat_id = $2"];

  if (opts.search) {
    params.push(opts.search);
    const p = params.length;
    // FTS when available — falls back to ILIKE on platforms without GIN.
    conds.push(
      `(to_tsvector('english', coalesce(body, '')) @@ plainto_tsquery('english', $${p})
        OR body ILIKE '%' || $${p} || '%')`,
    );
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_message_id, chat_id, sender, body, body_html,
            importance, created_at, updated_at, synced_at, payload
       FROM instinct_teams_messages
       WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const messages: TeamsMessage[] = taken.map(rowToMessage);
  const nextCursor = hasMore ? messages[messages.length - 1].id : null;
  return { messages, nextCursor };
}

function rowToChat(r: any): TeamsChat {
  return {
    id: r.id,
    userId: r.user_id,
    msChatId: r.ms_chat_id,
    chatType: r.chat_type as ChatType,
    topic: r.topic,
    participants:
      typeof r.participants === "string"
        ? JSON.parse(r.participants)
        : r.participants ?? [],
    lastUpdatedAt: r.last_updated_at ? new Date(r.last_updated_at).toISOString() : null,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function rowToMessage(r: any): TeamsMessage {
  return {
    id: r.id,
    userId: r.user_id,
    msMessageId: r.ms_message_id,
    chatId: r.chat_id,
    sender: typeof r.sender === "string" ? JSON.parse(r.sender) : r.sender ?? {},
    body: r.body ?? "",
    bodyHtml: r.body_html,
    importance: r.importance as "low" | "normal" | "high",
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    syncedAt: new Date(r.synced_at).toISOString(),
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {},
  };
}
