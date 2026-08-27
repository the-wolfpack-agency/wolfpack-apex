/**
 * Brain provider — the document corpus, which Universal Search could not see.
 *
 * THE GAP THIS CLOSES. Search fanned out to chats, email, calendar, channels,
 * curated knowledge, CRM, DMS and deployments. It did not fan out to the
 * documents. On 2026-08-27 that corpus held 1,251 documents, 665 of them
 * ingested from SharePoint, every chunk embedded, and none of it reachable
 * from search: a question about what a document said returned nothing while
 * the document sat right there, indexed, one table over.
 *
 * That is the worst shape of failure for a product sold on reading your
 * systems, because an empty result is indistinguishable from an empty corpus.
 *
 * WHY IT LINKS TO THE ORIGINAL WHERE ONE EXISTS. A SharePoint document has a
 * web_url, and sending somebody to the file they already have access to is
 * better than showing them a chunk of it. Where there is no original, the
 * result opens the Brain document instead.
 *
 * WHY THE SNIPPET IS NOT REBUILT. queryBrain already returns a highlighted
 * snippet chosen against the query. Re-deriving one from the raw chunk would
 * be a second, worse implementation of something that already ran.
 */

import { queryBrain } from "@/lib/brain/query";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { buildSnippet } from "./util";

/**
 * One row per DOCUMENT, not per chunk.
 *
 * Retrieval returns chunks, and three chunks of the same file are one result
 * to a person scanning a list. Keeping the best-scoring chunk per document
 * means the list is as long as it looks.
 */
function dedupeByDocument(
  hits: Awaited<ReturnType<typeof queryBrain>>["hits"],
): typeof hits {
  const best = new Map<string, (typeof hits)[number]>();
  for (const h of hits) {
    const key = String(h.document_id);
    const seen = best.get(key);
    if (!seen || h.score > seen.score) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  /* An empty query means "show me the filter's contents", which retrieval
     cannot answer: there is nothing to be relevant to. Returning nothing is
     correct here, and the other providers still populate the page. */
  if (!query.trim()) return [];

  const result = await queryBrain({
    userId: ctx.userId,
    userRole: "member",
    query,
    /* Over-fetch, because chunks collapse to documents below and asking for
       exactly the limit would return fewer rows than the caller asked for
       whenever a document matched more than once. */
    limit: Math.max(perTypeLimit * 3, perTypeLimit),
  });

  return dedupeByDocument(result.hits)
    .slice(0, perTypeLimit)
    .map((h) => ({
      type: "brain" as const,
      id: String(h.document_id),
      title: h.document_filename,
      /* The highlighted snippet retrieval already picked, falling back to the
         chunk only when it did not produce one. */
      snippet: h.snippet || buildSnippet(h.content, query),
      timestamp: "",
      /* The original where it exists, the ingested copy otherwise. */
      url: h.web_url || `/brain?doc=${encodeURIComponent(String(h.document_id))}`,
    }));
}

export const brainProvider: SearchProvider = {
  type: "brain",
  name: "Documents",
  countKey: "brain",
  isEnabled: () => true,
  search,
};
