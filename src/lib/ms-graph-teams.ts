/**
 * Graph helpers for Microsoft Teams' "team & channel" surface — the
 * persistent collaboration spaces, distinct from 1:1 / group `Chat`
 * objects covered by `ms-graph-chats.ts`.
 *
 * Endpoints used:
 *   - GET /me/joinedTeams                         → user's teams
 *   - GET /teams/{teamId}/channels                → channels in a team
 *   - GET /teams/{teamId}/channels/{id}/messages  → channel messages
 *
 * Required delegated scopes: Team.ReadBasic.All, Channel.ReadBasic.All,
 * ChannelMessage.Read.All. All three are already in MS_SCOPES.
 *
 * Triple-write-friendly: every public call fires a `ms_teams.*`
 * analytics event so the learning system can see usage. Scope-missing
 * results are explicit (never thrown) so the UI can render the same
 * "grant in settings" CTA pattern used for chats.
 */

import { trackEvent } from "@/lib/analytics";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JoinedTeam {
  id: string;
  displayName: string;
  description?: string;
}

export interface TeamChannel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: "standard" | "private" | "shared" | string;
  webUrl?: string;
}

export interface ChannelMessage {
  id: string;
  createdDateTime: string;
  from?: { displayName?: string; userId?: string; email?: string };
  body?: { contentType?: "text" | "html"; content?: string };
  bodyText?: string;
}

interface RawTeam {
  id?: string;
  displayName?: string;
  description?: string;
}
interface RawChannel {
  id?: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
}
interface RawMessage {
  id?: string;
  createdDateTime?: string;
  from?: {
    user?: { displayName?: string; id?: string };
    application?: { displayName?: string };
  } | null;
  body?: { contentType?: string; content?: string } | null;
}

type ScopeMissingResult = { ok: false; code: "scope_missing"; scope: string };
type ErrorResult = { ok: false; code: "error"; status: number };
type FailureResult = ScopeMissingResult | ErrorResult;

export type ListJoinedTeamsResult =
  | { ok: true; teams: JoinedTeam[] }
  | FailureResult;
export type ListTeamChannelsResult =
  | { ok: true; channels: TeamChannel[] }
  | FailureResult;
export type ListChannelMessagesResult =
  | { ok: true; messages: ChannelMessage[] }
  | FailureResult;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
            `[ms-graph-teams] Graph ${path} returned ${res.status}: ${errText.slice(0, 200)}`,
          );
        } catch {
          /* ignore */
        }
      }
      return { status: res.status, data: null };
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  } catch (err) {
    console.warn(
      `[ms-graph-teams] Graph ${path} fetch error:`,
      (err as Error).message,
    );
    return { status: 0, data: null };
  }
}

function stripHtmlServer(html: string): string {
  // Mirror of the page's strip — Graph channel messages can come back
  // as HTML; we surface a plain-text projection for UI previews + RAG.
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeTeam(raw: RawTeam): JoinedTeam | null {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    displayName: typeof raw.displayName === "string" ? raw.displayName : "",
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function normalizeChannel(raw: RawChannel): TeamChannel | null {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    displayName: typeof raw.displayName === "string" ? raw.displayName : "",
    description: typeof raw.description === "string" ? raw.description : undefined,
    membershipType:
      typeof raw.membershipType === "string"
        ? (raw.membershipType as TeamChannel["membershipType"])
        : undefined,
    webUrl: typeof raw.webUrl === "string" ? raw.webUrl : undefined,
  };
}

function normalizeMessage(raw: RawMessage): ChannelMessage | null {
  if (!raw?.id) return null;
  const body = raw.body ?? undefined;
  const content = typeof body?.content === "string" ? body.content : "";
  const contentType =
    body?.contentType === "html" || body?.contentType === "text"
      ? body.contentType
      : undefined;
  const bodyText =
    contentType === "html" ? stripHtmlServer(content) : content;
  const fromUser = raw.from?.user;
  const fromApp = raw.from?.application;
  return {
    id: raw.id,
    createdDateTime:
      typeof raw.createdDateTime === "string" ? raw.createdDateTime : "",
    body: { contentType, content },
    bodyText,
    from: fromUser
      ? { displayName: fromUser.displayName, userId: fromUser.id }
      : fromApp
        ? { displayName: fromApp.displayName }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TEAM_LIMIT = 50;
const DEFAULT_CHANNEL_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 30;

export async function listJoinedTeams(
  userMsToken: string,
  limit: number = DEFAULT_TEAM_LIMIT,
  userId: string = "system",
): Promise<ListJoinedTeamsResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit || DEFAULT_TEAM_LIMIT)));
  const qs = `/me/joinedTeams?$top=${safeLimit}`;
  const { status, data } = await graphGet<{ value?: RawTeam[] }>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_teams.scope_missing", userId, "system", { surface: "list_teams" });
    return { ok: false, code: "scope_missing", scope: "Team.ReadBasic.All" };
  }
  if (status < 200 || status >= 300) {
    // Anything else (400, 5xx, network 0) is a real error — don't
    // pretend the user has 0 teams. Surface it so the UI can say
    // "couldn't load Teams" rather than silently empty.
    trackEvent("ms_teams.scope_missing", userId, "system", {
      surface: "list_teams",
      error_status: status,
    });
    return { ok: false, code: "error", status };
  }
  const raw = Array.isArray(data?.value) ? data!.value : [];
  const teams = raw
    .map(normalizeTeam)
    .filter((t): t is JoinedTeam => t !== null);
  trackEvent("ms_teams.listed", userId, "system", { count: teams.length });
  return { ok: true, teams };
}

export async function listTeamChannels(
  userMsToken: string,
  teamId: string,
  limit: number = DEFAULT_CHANNEL_LIMIT,
  userId: string = "system",
): Promise<ListTeamChannelsResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit || DEFAULT_CHANNEL_LIMIT)));
  const qs = `/teams/${encodeURIComponent(teamId)}/channels?$top=${safeLimit}`;
  const { status, data } = await graphGet<{ value?: RawChannel[] }>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_teams.scope_missing", userId, "system", {
      surface: "list_channels",
      team_id: teamId,
    });
    return { ok: false, code: "scope_missing", scope: "Channel.ReadBasic.All" };
  }
  const raw = Array.isArray(data?.value) ? data!.value : [];
  const channels = raw
    .map(normalizeChannel)
    .filter((c): c is TeamChannel => c !== null);
  trackEvent("ms_teams.channels_listed", userId, "system", {
    team_id: teamId,
    count: channels.length,
  });
  return { ok: true, channels };
}

export async function listChannelMessages(
  userMsToken: string,
  teamId: string,
  channelId: string,
  limit: number = DEFAULT_MESSAGE_LIMIT,
  userId: string = "system",
): Promise<ListChannelMessagesResult> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit || DEFAULT_MESSAGE_LIMIT)));
  const qs =
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages` +
    `?$top=${safeLimit}`;
  const { status, data } = await graphGet<{ value?: RawMessage[] }>(qs, userMsToken);
  if (status === 401 || status === 403) {
    trackEvent("ms_teams.scope_missing", userId, "system", {
      surface: "channel_messages",
      team_id: teamId,
      channel_id: channelId,
    });
    return { ok: false, code: "scope_missing", scope: "ChannelMessage.Read.All" };
  }
  const raw = Array.isArray(data?.value) ? data!.value : [];
  const messages = raw
    .map(normalizeMessage)
    .filter((m): m is ChannelMessage => m !== null);
  trackEvent("ms_teams.channel_messages_loaded", userId, "system", {
    team_id: teamId,
    channel_id: channelId,
    count: messages.length,
  });
  return { ok: true, messages };
}
