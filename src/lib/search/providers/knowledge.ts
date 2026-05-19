/**
 * Knowledge provider — Instinct's curated KB. Empty query returns the
 * most recent / popular entries so the Knowledge filter shows
 * something on a bare /search?types=knowledge page load.
 * searchKnowledge handles empty by returning DEMO entries when no DB
 * is configured, and ILIKE '%%' matches everything when one is.
 */

import { searchKnowledge } from "@/lib/knowledge";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { buildSnippet } from "./util";

async function search(
  query: string,
  perTypeLimit: number,
  _ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const entries = await searchKnowledge(query, perTypeLimit);
  return entries.map((e) => ({
    type: "knowledge" as const,
    id: e.id,
    title: e.question,
    snippet: buildSnippet(e.answer, query),
    timestamp: e.updated_at || e.created_at || "",
    url: `/knowledge?id=${encodeURIComponent(e.id)}`,
  }));
}

export const knowledgeProvider: SearchProvider = {
  type: "knowledge",
  name: "Instinct knowledge",
  countKey: "knowledge",
  isEnabled: () => true,
  search,
};
