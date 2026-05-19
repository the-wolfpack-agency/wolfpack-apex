/**
 * GET /api/search?q=<query>&types=chats,channels,emails,calendar,knowledge,crm&limit=20
 *
 * Universal Search v2 — thin HTTP wrapper around `runSearch()`.
 *
 * All retrieval, even-share allocation, interleave and cap logic lives
 * in `@/lib/search/runSearch` so the assistant `search` tool returns
 * IDENTICAL results. Keep this handler dumb on purpose — auth,
 * input parsing, response framing, and insight events; nothing else.
 *
 * Response (re-exported from runSearch — see lib for the source of truth):
 *   {
 *     results: Array<{
 *       type: "chat" | "channel" | "email" | "calendar" | "knowledge" | "crm",
 *       id: string,
 *       title: string,
 *       snippet: string,
 *       timestamp: string,    // ISO
 *       url?: string,         // deep-link to source surface
 *     }>,
 *     took_ms: number,
 *     counts: { chats: number, channels: number, emails: number, calendar: number, knowledge: number, crm: number },
 *   }
 *
 * The `crm` provider fans out to whichever CRM connector(s) the
 * workspace has configured (Salesforce, HubSpot, generic REST). New
 * providers register in src/lib/search/providers/index.ts and surface
 * here automatically — no route changes required.
 *
 * Insights events fired (canonical via `emitInsight`):
 *   - insight.search.queried       — every request
 *   - insight.search.no_results    — when total results == 0 AND query non-empty
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { emitInsight } from "@/lib/insights/emit";
import {
  runSearch,
  ALL_SEARCH_TYPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  type SearchType,
  type SearchResponse,
  type SearchResult,
} from "@/lib/search/runSearch";

/* Re-export the types so existing imports from `@/app/api/search/route`
   keep working. Source of truth lives in the lib. */
export type { SearchResponse, SearchResult };
export type SearchResultType = SearchType;

/** Parse the comma-separated `types=` param. Empty/missing = all types.
 *  Maps the URL forms ("chats", "emails") onto the canonical singular
 *  result type ("chat", "email"). Unknown values are dropped silently. */
function parseTypes(raw: string | null): SearchType[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const map: Record<string, SearchType> = {
    chat: "chat",
    chats: "chat",
    channel: "channel",
    channels: "channel",
    email: "email",
    emails: "email",
    calendar: "calendar",
    knowledge: "knowledge",
    crm: "crm",
    salesforce: "crm",
    hubspot: "crm",
  };
  const out: SearchType[] = [];
  /* Hard cap on the number of comma-separated entries we'll even look
     at — defense against a query-string DoS that hands us a 10MB
     `types=chat,chat,chat,…` value. The canonical set is 5 entries; 32
     is plenty of head-room for typos + future additions. */
  const parts = raw.split(",", 32);
  for (const part of parts) {
    const t = map[part.trim().toLowerCase()];
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length === 0 ? undefined : out;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  /* Clamp q at MAX_QUERY_LENGTH BEFORE any work — defends the
     downstream substring matcher + the Graph helpers from a megabyte
     of query text. Also bounds the no-results insight `query` payload
     so a hostile caller can't blow analytics row sizes. */
  const q = (url.searchParams.get("q") || "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
  const types = parseTypes(url.searchParams.get("types"));
  const limitRaw = parseInt(
    url.searchParams.get("limit") || `${DEFAULT_LIMIT}`,
    10,
  );
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
  );

  const body = await runSearch(
    { query: q, types, limit },
    {
      userId: user.id,
      ...(user.workspaceId ? { workspaceId: user.workspaceId } : {}),
    },
  );

  /* `types=` payload mirrors what the request asked for; when callers
     omit it we record the full set so downstream analytics can still
     filter by surface. */
  const typesLabel = (types ?? ALL_SEARCH_TYPES.slice()).join(",");

  emitInsight({
    actor: user.id,
    role: user.role,
    surface: "search",
    action: "queried",
    tier: "personal",
    payload: {
      query_length: q.length,
      types: typesLabel,
      total_results: body.results.length,
      took_ms: body.took_ms,
    },
  });

  /* Zero-result event powers the docs-gap heatmap. Only fire when the
     user actually typed a query — empty q with no results is the
     initial /search page load, not a docs gap. */
  if (body.results.length === 0 && q.length > 0) {
    emitInsight({
      actor: user.id,
      role: user.role,
      surface: "search",
      action: "no_results",
      tier: "personal",
      payload: {
        query: q,
        types: typesLabel,
      },
    });
  }

  return NextResponse.json(body);
}
