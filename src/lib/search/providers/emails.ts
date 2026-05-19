/**
 * Emails provider — searches the user's 50 most-recent received emails
 * via Microsoft Graph. Matches the subject, the body preview, and the
 * sender. Hits open in Outlook when Graph returned a webLink, otherwise
 * fall back to the in-app /emails reader.
 */

import { fetchRecentEmails } from "@/lib/microsoft-graph";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { matches, buildSnippet } from "./util";

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const emails = await fetchRecentEmails(ctx.userId, 50);
  const out: SearchResult[] = [];
  for (const m of emails) {
    if (matches(m.subject, query) || matches(m.bodyPreview, query) || matches(m.from, query)) {
      const url = m.webLink
        ? m.webLink
        : `/emails?id=${encodeURIComponent(m.id)}`;
      out.push({
        type: "email",
        id: m.id,
        title: m.subject || "(no subject)",
        snippet: `From ${m.from}: ${buildSnippet(m.bodyPreview, query)}`,
        timestamp: m.receivedDateTime,
        url,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  return out;
}

export const emailsProvider: SearchProvider = {
  type: "email",
  name: "Outlook emails",
  countKey: "emails",
  isEnabled: () => true,
  search,
};
