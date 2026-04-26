/**
 * GET /api/search?q=<query>&types=chats,channels,emails,calendar,knowledge&limit=20
 *
 * Universal Search v1 — single search box across the user's MS Graph
 * surfaces (chats, channels, emails, calendar) plus Instinct knowledge.
 *
 * v1 strategy: server-side substring/keyword filtering over the user's
 * RECENTLY-FETCHED items via existing Graph helpers. This is intentionally
 * NOT semantic search — that's the Azure AI Search swap target. When we
 * cut over, this route's response shape stays identical; only the inner
 * `runQuery*` helpers get replaced with index lookups.
 *
 * v1 limitations (TODO for Azure AI Search swap):
 *   - Only searches the most recent N items per surface (no historical
 *     archive). Anything older than the Graph default window is invisible.
 *   - No ranking — simple recency order within each type. A real index
 *     gives BM25 + semantic hybrid scoring.
 *   - Channels: existing `ms-graph-chats.ts` does NOT expose a list-channels
 *     helper that returns messages — only direct chats. Channels skipped
 *     in v1; flagged with a `0` count so the UI chip can render disabled.
 *   - Knowledge: no public retriever helper is exposed at the lib level
 *     (the assistant route uses `tryToolAnswer` internally). Skipped in
 *     v1 with a `0` count and a TODO. Azure AI Search will own this.
 *
 * Response:
 *   {
 *     results: Array<{
 *       type: "chat" | "channel" | "email" | "calendar" | "knowledge",
 *       id: string,
 *       title: string,
 *       snippet: string,
 *       timestamp: string,    // ISO
 *       url?: string,         // deep-link to source surface
 *     }>,
 *     took_ms: number,
 *     counts: { chats: number, channels: number, emails: number, calendar: number, knowledge: number },
 *   }
 *
 * Insights events fired (canonical via `emitInsight`):
 *   - insight.search.queried       — every request
 *   - insight.search.no_results    — when total results == 0 AND query non-empty
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken, fetchRecentEmails, fetchCalendarEvents } from "@/lib/microsoft-graph";
import { listChatsResult, getChatMessagesResult } from "@/lib/ms-graph-chats";
import { listJoinedTeams, listTeamChannels, listChannelMessages } from "@/lib/ms-graph-teams";
import { searchKnowledge } from "@/lib/knowledge";
import { emitInsight } from "@/lib/insights/emit";

export type SearchResultType = "chat" | "channel" | "email" | "calendar" | "knowledge";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  timestamp: string;
  url?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  took_ms: number;
  counts: {
    chats: number;
    channels: number;
    emails: number;
    calendar: number;
    knowledge: number;
  };
}

const ALL_TYPES: SearchResultType[] = ["chat", "channel", "email", "calendar", "knowledge"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Parse the comma-separated `types=` param. Empty/missing = all types.
 * Maps the URL forms ("chats", "emails") onto the canonical singular
 * result type ("chat", "email"). Unknown values are dropped silently.
 */
function parseTypes(raw: string | null): Set<SearchResultType> {
  if (!raw || !raw.trim()) return new Set(ALL_TYPES);
  const map: Record<string, SearchResultType> = {
    chat: "chat",
    chats: "chat",
    channel: "channel",
    channels: "channel",
    email: "email",
    emails: "email",
    calendar: "calendar",
    knowledge: "knowledge",
  };
  const out = new Set<SearchResultType>();
  for (const part of raw.split(",")) {
    const t = map[part.trim().toLowerCase()];
    if (t) out.add(t);
  }
  return out.size === 0 ? new Set(ALL_TYPES) : out;
}

/** Case-insensitive substring match — naive but sufficient for v1. */
function matches(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Trim a snippet to ~140 chars centered around the first match position
 * so the user sees context, not always the start of the body.
 */
function buildSnippet(body: string, q: string): string {
  const text = (body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!q) return text.slice(0, 140);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 140);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 100);
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

async function searchChats(userId: string, q: string, perTypeLimit: number): Promise<SearchResult[]> {
  const token = await getValidToken(userId);
  if (!token) return [];
  const listed = await listChatsResult(token.accessToken, 30, userId);
  if (!listed.ok) return [];
  const out: SearchResult[] = [];
  for (const chat of listed.chats) {
    const previewBody = chat.lastMessagePreview?.bodyText ?? "";
    const topic = chat.topic || chat.members.map((m) => m.displayName || m.email).slice(0, 3).join(", ");
    if (matches(topic, q) || matches(previewBody, q)) {
      out.push({
        type: "chat",
        id: chat.id,
        title: topic || "(untitled chat)",
        snippet: buildSnippet(previewBody, q),
        timestamp: chat.lastUpdatedDateTime || chat.lastMessagePreview?.createdDateTime || "",
        url: `/messages?chat=${encodeURIComponent(chat.id)}`,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  // If still under cap and we have a query, dig into the most recent
  // chats' messages for body matches the preview missed. Capped to keep
  // Graph traffic bounded.
  if (q && out.length < perTypeLimit) {
    const seen = new Set(out.map((r) => r.id));
    for (const chat of listed.chats.slice(0, 5)) {
      if (seen.has(chat.id)) continue;
      const msgs = await getChatMessagesResult(token.accessToken, chat.id, 20, userId);
      if (!msgs.ok) continue;
      const hit = msgs.messages.find((m) => matches(m.bodyText, q));
      if (hit) {
        const topic = chat.topic || chat.members.map((m) => m.displayName || m.email).slice(0, 3).join(", ");
        out.push({
          type: "chat",
          id: chat.id,
          title: topic || "(untitled chat)",
          snippet: buildSnippet(hit.bodyText, q),
          timestamp: hit.createdDateTime,
          url: `/messages?chat=${encodeURIComponent(chat.id)}`,
        });
        if (out.length >= perTypeLimit) break;
      }
    }
  }
  return out;
}

async function searchEmails(userId: string, q: string, perTypeLimit: number): Promise<SearchResult[]> {
  const emails = await fetchRecentEmails(userId, 50);
  const out: SearchResult[] = [];
  for (const m of emails) {
    if (matches(m.subject, q) || matches(m.bodyPreview, q) || matches(m.from, q)) {
      out.push({
        type: "email",
        id: m.id,
        title: m.subject || "(no subject)",
        snippet: `From ${m.from}: ${buildSnippet(m.bodyPreview, q)}`,
        timestamp: m.receivedDateTime,
        url: `/emails?id=${encodeURIComponent(m.id)}`,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  return out;
}

async function searchCalendar(userId: string, q: string, perTypeLimit: number): Promise<SearchResult[]> {
  // 30-day window centered on today: 7 days back, 23 days forward.
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const end = new Date(now);
  end.setDate(end.getDate() + 23);
  const events = await fetchCalendarEvents(userId, start.toISOString(), end.toISOString());
  const out: SearchResult[] = [];
  for (const ev of events) {
    const attendees = ev.attendees.join(", ");
    if (matches(ev.subject, q) || matches(attendees, q) || matches(ev.location, q)) {
      out.push({
        type: "calendar",
        id: ev.id,
        title: ev.subject || "(no subject)",
        snippet: [ev.location, attendees ? `with ${attendees}` : ""].filter(Boolean).join(" · "),
        timestamp: ev.start,
        url: ev.webLink || `/calendar?event=${encodeURIComponent(ev.id)}`,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  return out;
}

async function searchChannels(userId: string, q: string, perTypeLimit: number): Promise<SearchResult[]> {
  const token = await getValidToken(userId);
  if (!token) return [];
  const teamsRes = await listJoinedTeams(token.accessToken, 10, userId);
  if (!teamsRes.ok) return [];
  const out: SearchResult[] = [];
  // Stage 1: cheap channel-name/description match across the user's
  // top teams. Bounded — top 8 teams, top 20 channels per team.
  const channelTriples: Array<{ teamId: string; teamName: string; channel: { id: string; displayName: string; description?: string; webUrl?: string } }> = [];
  for (const team of teamsRes.teams.slice(0, 8)) {
    const chRes = await listTeamChannels(token.accessToken, team.id, 20, userId);
    if (!chRes.ok) continue;
    for (const ch of chRes.channels) {
      channelTriples.push({ teamId: team.id, teamName: team.displayName, channel: ch });
      if (matches(ch.displayName, q) || matches(ch.description || "", q) || matches(team.displayName, q)) {
        out.push({
          type: "channel",
          id: `${team.id}:${ch.id}`,
          title: `${team.displayName} · ${ch.displayName}`,
          snippet: ch.description || "",
          timestamp: "",
          url: `/messages?team=${encodeURIComponent(team.id)}&channel=${encodeURIComponent(ch.id)}`,
        });
        if (out.length >= perTypeLimit) return out;
      }
    }
  }
  // Stage 2: with a query and remaining slots, scan recent messages in
  // up to 5 channels we haven't already matched. Capped to keep Graph
  // traffic bounded — heavy queries are the index's job, not v1's.
  if (q && out.length < perTypeLimit) {
    const seen = new Set(out.map((r) => r.id));
    for (const t of channelTriples) {
      const composite = `${t.teamId}:${t.channel.id}`;
      if (seen.has(composite)) continue;
      const msgs = await listChannelMessages(token.accessToken, t.teamId, t.channel.id, 20, userId);
      if (!msgs.ok) continue;
      const hit = msgs.messages.find((m) => matches(m.bodyText || "", q));
      if (hit) {
        out.push({
          type: "channel",
          id: composite,
          title: `${t.teamName} · ${t.channel.displayName}`,
          snippet: buildSnippet(hit.bodyText || "", q),
          timestamp: hit.createdDateTime,
          url: `/messages?team=${encodeURIComponent(t.teamId)}&channel=${encodeURIComponent(t.channel.id)}`,
        });
        if (out.length >= perTypeLimit) break;
      }
    }
  }
  return out;
}

async function searchKnowledgeEntries(q: string, perTypeLimit: number): Promise<SearchResult[]> {
  // Empty query → return the most recent / popular entries so the
  // Knowledge filter shows *something* on a bare /search?types=knowledge.
  // searchKnowledge handles empty by returning DEMO entries when no DB
  // is configured, and ILIKE '%%' matches everything when one is.
  const entries = await searchKnowledge(q, perTypeLimit);
  return entries.map((e) => ({
    type: "knowledge" as const,
    id: e.id,
    title: e.question,
    snippet: buildSnippet(e.answer, q),
    timestamp: e.updated_at || e.created_at || "",
    url: `/knowledge?id=${encodeURIComponent(e.id)}`,
  }));
}

/**
 * Even-share allocation across requested types. With N types and
 * `limit` total slots, each type gets ceil(limit/N) — small enough
 * that we don't starve any one type. The aggregator caps the final
 * concatenated list at `limit` after merging.
 */
function perTypeLimit(types: Set<SearchResultType>, limit: number): number {
  return Math.max(2, Math.ceil(limit / Math.max(1, types.size)));
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const types = parseTypes(url.searchParams.get("types"));
  const limitRaw = parseInt(url.searchParams.get("limit") || `${DEFAULT_LIMIT}`, 10);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const perType = perTypeLimit(types, limit);

  // Run the per-type queries in parallel. Each is independently
  // best-effort — a Graph 401 in one surface doesn't block another.
  const [chatResults, emailResults, calendarResults, channelResults, knowledgeResults] = await Promise.all([
    types.has("chat") ? searchChats(user.id, q, perType).catch(() => []) : Promise.resolve<SearchResult[]>([]),
    types.has("email") ? searchEmails(user.id, q, perType).catch(() => []) : Promise.resolve<SearchResult[]>([]),
    types.has("calendar") ? searchCalendar(user.id, q, perType).catch(() => []) : Promise.resolve<SearchResult[]>([]),
    types.has("channel") ? searchChannels(user.id, q, perType).catch(() => []) : Promise.resolve<SearchResult[]>([]),
    types.has("knowledge") ? searchKnowledgeEntries(q, perType).catch(() => []) : Promise.resolve<SearchResult[]>([]),
  ]);

  // Merge then cap. Within each type the underlying helpers preserve
  // recency order; the merged list interleaves by alternating types
  // so no single type dominates the first page when one returned many
  // matches.
  const merged: SearchResult[] = [];
  const buckets = [chatResults, emailResults, calendarResults, channelResults, knowledgeResults];
  let added = true;
  let idx = 0;
  while (added && merged.length < limit) {
    added = false;
    for (const b of buckets) {
      if (idx < b.length && merged.length < limit) {
        merged.push(b[idx]);
        added = true;
      }
    }
    idx += 1;
  }

  const took_ms = Date.now() - t0;
  const counts = {
    chats: chatResults.length,
    channels: channelResults.length,
    emails: emailResults.length,
    calendar: calendarResults.length,
    knowledge: knowledgeResults.length,
  };

  emitInsight({
    actor: user.id,
    role: user.role,
    surface: "search",
    action: "queried",
    tier: "personal",
    payload: {
      query_length: q.length,
      types: Array.from(types).join(","),
      total_results: merged.length,
      took_ms,
    },
  });

  // Zero-result event powers the docs-gap heatmap. Only fire when the
  // user actually typed a query — empty q with no results is the
  // initial /search page load, not a docs gap.
  if (merged.length === 0 && q.length > 0) {
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "search",
      action: "no_results",
      tier: "personal",
      payload: {
        query: q.slice(0, 200),
        types: Array.from(types).join(","),
      },
    });
  }

  const body: SearchResponse = { results: merged, took_ms, counts };
  return NextResponse.json(body);
}
