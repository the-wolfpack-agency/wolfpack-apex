/**
 * SharePoint provider — their documents, searched where they already sit.
 *
 * THE GAP THIS CLOSES, AND THE ONE IT DOES NOT. Universal Search fanned out to
 * chats, email, calendar, channels, curated knowledge, the Brain, CRM, DMS and
 * deployments. Nine providers, none of which asks SharePoint directly. The
 * Brain covers documents we have INGESTED: on 2026-08-28 that was 1,251
 * documents, 665 of them from SharePoint. Everything else in the client's
 * library was invisible to search, and "find coaching calls spreasheet" was
 * typed 36 times in sixty days.
 *
 * WHY THIS IS A PROVIDER AND NOT A NEW INTEGRATION. microsoft-sharepoint.ts
 * already does the hard part and has since before this file existed: delegated
 * /search/query across driveItem, listItem and site, typed failures, and a
 * keyword extractor that exists because passing a verbatim question like
 * "What's in the TWA Agenda 4.20 doc?" against TWA_Agenda_4.20.docx returns
 * zero hits.
 *
 * I wrote a second copy of that module before finding it. The integration
 * inventory caught it, which is what that inventory is for. The gap was never
 * the Graph call; it was that nothing connected the Graph call to search.
 *
 * COMPLEMENTARY TO THE BRAIN, NOT A REPLACEMENT. They answer different halves
 * of a document question. This one finds WHICH FILE, needs nothing ingested,
 * is never stale, and is scoped by the reader's own SharePoint permissions
 * rather than by a copy of them we maintain. The Brain answers WHAT IS INSIDE
 * one, semantically and with citations, which genuinely requires text we hold.
 * Ranked together in one list and labelled distinctly, so a reader can tell
 * which of their documents we hold a copy of and which is still theirs.
 *
 * A FAILURE IS NOT AN EMPTY LIBRARY. Every reason searchSharePoint returns is
 * a different sentence, and the one thing this must never do is render "your
 * SharePoint has nothing in it" when the truth is "the scope was never granted"
 * or "we asked too often". A failure contributes no results and the fan-out
 * carries on without it, rather than adding a confident zero to a count
 * somebody reads as a fact about their own library.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  searchSharePoint,
  trackSharePointLookupFailure,
} from "@/lib/integrations/microsoft-sharepoint";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  /* An empty query cannot be answered by a search index: there is nothing to
     be relevant to. Asking anyway would spend a Graph call to learn that. */
  if (!query.trim()) return [];

  /* getValidToken returns { accessToken, userEmail }, not a bare string.
     Reading it as one sends the literal "[object Object]" as the bearer token,
     which comes back 401 and reports as "this user never connected their
     account" - a setup instruction, in answer to a bug. */
  const auth = await getValidToken(ctx.userId).catch(() => null);
  if (!auth?.accessToken) return [];

  const result = await searchSharePoint(auth.accessToken, {
    query,
    topN: perTypeLimit,
  });

  if (!result.ok) {
    /* Recorded where the integration's own health reporting can see it, so a
       tenant that has never granted Sites.Read.All shows up as a scope problem
       rather than as a quiet absence of documents. */
    trackSharePointLookupFailure(ctx.userId, "member", result);
    return [];
  }

  return result.value.hits.map((h) => ({
    type: "sharepoint" as const,
    /* The drive item id where there is one, the URL otherwise: list items and
       sites have no driveItemId and still need to be addressable. */
    id: h.driveItemId ?? h.url,
    title: h.title,
    snippet: h.snippet,
    timestamp: h.modifiedAt,
    /* Opens the file in place, in their SharePoint, under their permissions. */
    url: h.url,
  }));
}

export const sharepointProvider: SearchProvider = {
  type: "sharepoint",
  name: "SharePoint",
  countKey: "sharepoint",
  /* Enabled unconditionally. Whether this reader has a connected account is
     decided above by the token lookup; duplicating that check here would be a
     second copy of the same question that could disagree with the first. */
  isEnabled: () => true,
  search,
};
