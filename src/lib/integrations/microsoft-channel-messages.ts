/**
 * Microsoft Teams CHANNEL messages integration (Tier 2 · Stream E).
 *
 * Unlike personal chats (`microsoft-teams-chat.ts` which reads /me/chats),
 * channel messages live under /teams/{id}/channels/{id}/messages. Requires
 * the `ChannelMessage.Read.All` delegated scope (added by Stream D to
 * MS_SCOPES). Writes/replies (`ChannelMessage.Send`) are OUT of Tier 2
 * scope; the POST reply route deliberately returns 501 with an explanation.
 *
 * Graph surface:
 *   GET /me/joinedTeams
 *   GET /teams/{id}/channels
 *   GET /teams/{id}/channels/{id}/messages?$top=
 *   GET /teams/{id}/channels/{id}/messages/{id}/replies
 *
 * Rate limits: Graph 429 Retry-After honored once per call, capped 60s.
 * 403 surfaces as a typed error so routes can return scope_missing.
 *
 * RAG hookup: every synced message is fed into the Assistant RAG via the
 * inline `indexTeamsChannelMessage` helper below (source=teams_channel_message).
 * The helper is stream-local to avoid parallel-stream edits on the shared
 * ms-content-ingest.ts file. Indexing failures emit
 * `system.ms_teams_channel_sync_indexing_failed` and the sync continues —
 * never blocks.
 */
 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { saveAnswer } from "@/lib/knowledge";
import { htmlToPlaintext } from "@/lib/integrations/microsoft-teams-chat";

// ---------------------------------------------------------------------------
// RAG ingest (stream-local)
// ---------------------------------------------------------------------------

export interface TeamsChannelIngestMessage {
  msMessageId: string;
  channelId: string; // local UUID
  msChannelId: string;
  teamName: string | null;
  channelName: string | null;
  sender: string;
  body: string;
  subject: string | null;
  createdAt: string;
}

export async function indexTeamsChannelMessage(
  userId: string,
  msg: TeamsChannelIngestMessage,
): Promise<void> {
  if (!msg.body || msg.body.trim().length === 0) return;
  const team = msg.teamName ? ` in ${msg.teamName}` : "";
  const channel = msg.channelName ? `#${msg.channelName}` : "(channel)";
  const question = `Teams channel post by ${msg.sender}${team} ${channel}: ${msg.body.slice(0, 160)}`;
  const answer =
    msg.subject && msg.subject.length > 0
      ? `${msg.subject}\n\n${msg.body}`
      : msg.body;
  const entry = await saveAnswer(
    question,
    answer,
    "teams_channel_message",
    userId,
    undefined,
    undefined,
    0,
  );
  if (!entry) {
    throw new Error(
      `saveAnswer returned null for teams channel message ${msg.msMessageId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelMembershipType = "standard" | "private" | "shared";

export interface Team {
  id: string; // local UUID
  msTeamId: string;
  userId: string;
  displayName: string;
  description: string | null;
  internalId: string | null;
  visibility: string | null;
  createdAt: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface Channel {
  id: string; // local UUID
  teamId: string;
  msChannelId: string;
  displayName: string;
  description: string | null;
  membershipType: ChannelMembershipType;
  createdAt: string | null;
  syncedAt: string;
}

export interface ChannelMessageSender {
  id?: string;
  displayName: string;
  email?: string;
}

export interface ChannelMessageMention {
  id?: number | string;
  mentionText?: string;
  mentioned?: {
    user?: {
      id?: string;
      displayName?: string;
      userIdentityType?: string;
    };
  };
}

export interface ChannelMessage {
  id: string; // local UUID
  msMessageId: string;
  channelId: string; // local channel UUID
  msReplyToId: string | null;
  sender: ChannelMessageSender;
  subject: string | null;
  body: string; // plaintext
  bodyHtml: string | null;
  importance: "low" | "normal" | "high";
  createdAt: string;
  updatedAt: string | null;
  mentions: ChannelMessageMention[];
  syncedAt: string;
  payload: Record<string, unknown>;
}

export interface ListMessagesOpts {
  top?: number;
  cursor?: string;
}

export interface SyncOpts {
  messagesPerChannel?: number;
}

export interface SyncResult {
  teamCount: number;
  channelCount: number;
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

export class ChannelMessagesError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ChannelMessagesError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_RETRY_AFTER_MS = 60 * 1000;

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new ChannelMessagesError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

async function graphGet<T = unknown>(
  endpoint: string,
  accessToken: string,
): Promise<T> {
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
      throw new ChannelMessagesError(
        retry.status,
        `Graph GET ${endpoint} failed after retry: ${retry.status}`,
        Math.ceil(raMs / 1000),
      );
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new ChannelMessagesError(
      res.status,
      `Graph GET ${endpoint} failed: ${res.status} ${text}`,
    );
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphTeam {
  id: string;
  displayName?: string;
  description?: string | null;
  internalId?: string | null;
  visibility?: string | null;
  createdDateTime?: string | null;
  "@odata.etag"?: string;
}

interface GraphChannel {
  id: string;
  displayName?: string;
  description?: string | null;
  membershipType?: string;
  createdDateTime?: string | null;
}

interface GraphChannelMessage {
  id: string;
  replyToId?: string | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  importance?: string;
  subject?: string | null;
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
  mentions?: ChannelMessageMention[];
  [k: string]: unknown;
}

function coerceMembershipType(t: string | undefined): ChannelMembershipType {
  if (t === "private" || t === "shared") return t;
  return "standard";
}

function coerceImportance(i: string | undefined): "low" | "normal" | "high" {
  const v = (i || "normal").toLowerCase();
  if (v === "low" || v === "high") return v;
  return "normal";
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertTeam(userId: string, g: GraphTeam): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_teams_teams
       (user_id, ms_team_id, display_name, description, internal_id,
        visibility, created_at, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id, ms_team_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       internal_id = EXCLUDED.internal_id,
       visibility = EXCLUDED.visibility,
       created_at = EXCLUDED.created_at,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [
      userId,
      g.id,
      g.displayName ?? "",
      g.description ?? null,
      g.internalId ?? null,
      g.visibility ?? null,
      g.createdDateTime ? new Date(g.createdDateTime).toISOString() : null,
      g["@odata.etag"] ?? null,
    ],
  );
  return rows[0].id;
}

async function upsertChannel(teamUuid: string, g: GraphChannel): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_teams_channels
       (team_id, ms_channel_id, display_name, description,
        membership_type, created_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (ms_channel_id) DO UPDATE SET
       team_id = EXCLUDED.team_id,
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       membership_type = EXCLUDED.membership_type,
       created_at = EXCLUDED.created_at,
       synced_at = now()
     RETURNING id`,
    [
      teamUuid,
      g.id,
      g.displayName ?? "",
      g.description ?? null,
      coerceMembershipType(g.membershipType),
      g.createdDateTime ? new Date(g.createdDateTime).toISOString() : null,
    ],
  );
  return rows[0].id;
}

async function upsertMessage(
  channelUuid: string,
  g: GraphChannelMessage,
): Promise<string> {
  const bodyHtml = g.body?.contentType === "html" ? g.body?.content ?? null : null;
  const bodyRaw = g.body?.content ?? "";
  const bodyPlain =
    g.body?.contentType === "html" ? htmlToPlaintext(bodyRaw) : bodyRaw;

  const sender: ChannelMessageSender = {
    id: g.from?.user?.id,
    displayName: g.from?.user?.displayName || "Unknown",
  };

  const createdAt = g.createdDateTime
    ? new Date(g.createdDateTime).toISOString()
    : new Date().toISOString();
  const updatedAt = g.lastModifiedDateTime
    ? new Date(g.lastModifiedDateTime).toISOString()
    : null;

  const mentions = Array.isArray(g.mentions) ? g.mentions : [];

  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_teams_channel_messages
       (channel_id, ms_message_id, ms_reply_to_id, sender, subject,
        body, body_html, importance, created_at, updated_at,
        mentions, synced_at, payload)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, now(), $12::jsonb)
     ON CONFLICT (ms_message_id) DO UPDATE SET
       channel_id = EXCLUDED.channel_id,
       ms_reply_to_id = EXCLUDED.ms_reply_to_id,
       sender = EXCLUDED.sender,
       subject = EXCLUDED.subject,
       body = EXCLUDED.body,
       body_html = EXCLUDED.body_html,
       importance = EXCLUDED.importance,
       updated_at = EXCLUDED.updated_at,
       mentions = EXCLUDED.mentions,
       synced_at = now(),
       payload = EXCLUDED.payload
     RETURNING id`,
    [
      channelUuid,
      g.id,
      g.replyToId ?? null,
      JSON.stringify(sender),
      g.subject ?? null,
      bodyPlain,
      bodyHtml,
      coerceImportance(g.importance),
      createdAt,
      updatedAt,
      JSON.stringify(mentions),
      JSON.stringify(g),
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listMyTeams(userId: string): Promise<GraphTeam[]> {
  const token = await resolveToken(userId);
  const res = await graphGet<{ value?: GraphTeam[] }>("me/joinedTeams", token);
  return res.value ?? [];
}

export async function listChannels(
  userId: string,
  teamId: string,
): Promise<GraphChannel[]> {
  const token = await resolveToken(userId);
  const res = await graphGet<{ value?: GraphChannel[] }>(
    `teams/${encodeURIComponent(teamId)}/channels`,
    token,
  );
  return res.value ?? [];
}

export async function listChannelMessages(
  userId: string,
  teamId: string,
  channelId: string,
  opts: ListMessagesOpts = {},
): Promise<{ messages: GraphChannelMessage[]; nextCursor?: string }> {
  const token = await resolveToken(userId);
  const top = Math.min(Math.max(opts.top ?? 50, 1), 50);
  const endpoint =
    opts.cursor ??
    `teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${top}`;
  const res = await graphGet<{
    value?: GraphChannelMessage[];
    "@odata.nextLink"?: string;
  }>(endpoint, token);
  return {
    messages: res.value ?? [],
    nextCursor: res["@odata.nextLink"],
  };
}

export async function listReplies(
  userId: string,
  teamId: string,
  channelId: string,
  messageId: string,
): Promise<GraphChannelMessage[]> {
  const token = await resolveToken(userId);
  const res = await graphGet<{ value?: GraphChannelMessage[] }>(
    `teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
    token,
  );
  return res.value ?? [];
}

export async function syncAllChannels(
  userId: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const start = Date.now();
  const messagesPerChannel = Math.min(
    Math.max(opts.messagesPerChannel ?? 50, 1),
    200,
  );

  try {
    const teams = await listMyTeams(userId);
    let teamCount = 0;
    let channelCount = 0;
    let messageCount = 0;

    for (const team of teams) {
      const teamUuid = await upsertTeam(userId, team);
      teamCount++;

      const channels = await listChannels(userId, team.id);
      for (const ch of channels) {
        const channelUuid = await upsertChannel(teamUuid, ch);
        channelCount++;

        const { messages } = await listChannelMessages(
          userId,
          team.id,
          ch.id,
          { top: messagesPerChannel },
        );

        for (const m of messages) {
          await upsertMessage(channelUuid, m);
          messageCount++;
          await tryIndexMessage(userId, channelUuid, team, ch, m);

          if ((m as any).replyToId === null || (m as any).replyToId === undefined) {
            try {
              const replies = await listReplies(userId, team.id, ch.id, m.id);
              for (const r of replies) {
                await upsertMessage(channelUuid, r);
                messageCount++;
                await tryIndexMessage(userId, channelUuid, team, ch, r);
              }
            } catch (replyErr) {
              if (
                !(replyErr instanceof ChannelMessagesError) ||
                replyErr.status !== 404
              ) {
                throw replyErr;
              }
            }
          }
        }
      }
    }

    const durationMs = Date.now() - start;
    trackEvent("system.ms_teams_channels_synced", userId, "system", {
      user_id: userId,
      team_count: teamCount,
      channel_count: channelCount,
      duration_ms: durationMs,
    });
    trackEvent("system.ms_teams_channel_messages_synced", userId, "system", {
      user_id: userId,
      message_count: messageCount,
      duration_ms: durationMs,
    });

    return { teamCount, channelCount, messageCount, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const status = err instanceof ChannelMessagesError ? err.status : 0;
    trackEvent("system.ms_teams_channel_sync_failed", userId, "system", {
      user_id: userId,
      error: (err as Error).message,
      http_status: status,
      duration_ms: durationMs,
    });
    throw err;
  }
}

async function tryIndexMessage(
  userId: string,
  channelUuid: string,
  team: GraphTeam,
  channel: GraphChannel,
  m: GraphChannelMessage,
): Promise<void> {
  try {
    const bodyPlain =
      m.body?.contentType === "html"
        ? htmlToPlaintext(m.body?.content ?? "")
        : m.body?.content ?? "";
    const ingest: TeamsChannelIngestMessage = {
      msMessageId: m.id,
      channelId: channelUuid,
      msChannelId: channel.id,
      teamName: team.displayName ?? null,
      channelName: channel.displayName ?? null,
      sender: m.from?.user?.displayName || "Unknown",
      body: bodyPlain,
      subject: m.subject ?? null,
      createdAt: m.createdDateTime
        ? new Date(m.createdDateTime).toISOString()
        : new Date().toISOString(),
    };
    await indexTeamsChannelMessage(userId, ingest);
  } catch (ingestErr) {
    trackEvent(
      "system.ms_teams_channel_sync_indexing_failed",
      userId,
      "system",
      {
        ms_message_id: m.id,
        error: (ingestErr as Error).message,
      },
    );
  }
}

export function asScopeMissing(
  err: unknown,
  scope: string,
): ScopeMissingError | null {
  if (err instanceof ChannelMessagesError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache read helpers
// ---------------------------------------------------------------------------

export async function listCachedTeams(userId: string): Promise<Team[]> {
  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_team_id, display_name, description, internal_id,
            visibility, created_at, etag, synced_at
       FROM instinct_teams_teams
       WHERE user_id = $1
       ORDER BY display_name ASC`,
    [userId],
  );
  return rows.map(rowToTeam);
}

export async function getCachedTeamById(
  userId: string,
  localId: string,
): Promise<Team | null> {
  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_team_id, display_name, description, internal_id,
            visibility, created_at, etag, synced_at
       FROM instinct_teams_teams
       WHERE user_id = $1 AND id = $2
       LIMIT 1`,
    [userId, localId],
  );
  if (rows.length === 0) return null;
  return rowToTeam(rows[0]);
}

export async function listCachedChannels(
  userId: string,
  teamLocalId: string,
): Promise<Channel[]> {
  const { rows } = await safeQuery<any>(
    `SELECT c.id, c.team_id, c.ms_channel_id, c.display_name, c.description,
            c.membership_type, c.created_at, c.synced_at
       FROM instinct_teams_channels c
       JOIN instinct_teams_teams t ON t.id = c.team_id
       WHERE t.user_id = $1 AND c.team_id = $2
       ORDER BY c.display_name ASC`,
    [userId, teamLocalId],
  );
  return rows.map(rowToChannel);
}

export async function getCachedChannelById(
  userId: string,
  channelLocalId: string,
): Promise<Channel | null> {
  const { rows } = await safeQuery<any>(
    `SELECT c.id, c.team_id, c.ms_channel_id, c.display_name, c.description,
            c.membership_type, c.created_at, c.synced_at
       FROM instinct_teams_channels c
       JOIN instinct_teams_teams t ON t.id = c.team_id
       WHERE t.user_id = $1 AND c.id = $2
       LIMIT 1`,
    [userId, channelLocalId],
  );
  if (rows.length === 0) return null;
  return rowToChannel(rows[0]);
}

export interface ListCachedChannelMessagesOpts {
  limit?: number;
  cursor?: string;
  search?: string;
  since?: string;
  mentionedUserId?: string;
}

export async function listCachedChannelMessages(
  userId: string,
  channelLocalId: string,
  opts: ListCachedChannelMessagesOpts = {},
): Promise<{ messages: ChannelMessage[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId, channelLocalId];
  const conds: string[] = ["t.user_id = $1", "m.channel_id = $2"];

  if (opts.search) {
    params.push(opts.search);
    const p = params.length;
    conds.push(
      `(to_tsvector('english', coalesce(m.subject, '') || ' ' || coalesce(m.body, '')) @@ plainto_tsquery('english', $${p})
        OR m.body ILIKE '%' || $${p} || '%'
        OR m.subject ILIKE '%' || $${p} || '%')`,
    );
  }
  if (opts.since) {
    params.push(opts.since);
    conds.push(`m.created_at >= $${params.length}`);
  }
  if (opts.mentionedUserId) {
    params.push(opts.mentionedUserId);
    conds.push(
      `m.mentions @> jsonb_build_array(jsonb_build_object('mentioned', jsonb_build_object('user', jsonb_build_object('id', $${params.length}::text))))`,
    );
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`m.id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await safeQuery<any>(
    `SELECT m.id, m.channel_id, m.ms_message_id, m.ms_reply_to_id, m.sender,
            m.subject, m.body, m.body_html, m.importance, m.created_at,
            m.updated_at, m.mentions, m.synced_at, m.payload
       FROM instinct_teams_channel_messages m
       JOIN instinct_teams_channels c ON c.id = m.channel_id
       JOIN instinct_teams_teams t ON t.id = c.team_id
       WHERE ${conds.join(" AND ")}
       ORDER BY m.created_at DESC, m.id ASC
       LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const messages: ChannelMessage[] = taken.map(rowToMessage);
  const nextCursor = hasMore ? messages[messages.length - 1].id : null;
  return { messages, nextCursor };
}

function rowToTeam(r: any): Team {
  return {
    id: r.id,
    userId: r.user_id,
    msTeamId: r.ms_team_id,
    displayName: r.display_name ?? "",
    description: r.description,
    internalId: r.internal_id,
    visibility: r.visibility,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function rowToChannel(r: any): Channel {
  return {
    id: r.id,
    teamId: r.team_id,
    msChannelId: r.ms_channel_id,
    displayName: r.display_name ?? "",
    description: r.description,
    membershipType: (r.membership_type as ChannelMembershipType) || "standard",
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function rowToMessage(r: any): ChannelMessage {
  return {
    id: r.id,
    channelId: r.channel_id,
    msMessageId: r.ms_message_id,
    msReplyToId: r.ms_reply_to_id,
    sender: typeof r.sender === "string" ? JSON.parse(r.sender) : r.sender ?? {},
    subject: r.subject,
    body: r.body ?? "",
    bodyHtml: r.body_html,
    importance: (r.importance as "low" | "normal" | "high") || "normal",
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    mentions: Array.isArray(r.mentions)
      ? r.mentions
      : typeof r.mentions === "string"
        ? JSON.parse(r.mentions)
        : [],
    syncedAt: new Date(r.synced_at).toISOString(),
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {},
  };
}
