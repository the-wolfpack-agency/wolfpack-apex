/**
 * Chats provider — searches the user's most-recent 1:1 + group chats
 * via Microsoft Graph. Stage 1 matches the chat topic / lastMessage
 * preview; stage 2 dips into a small sample of recent chats' message
 * bodies for matches the preview missed.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import { listChatsResult, getChatMessagesResult } from "@/lib/ms-graph-chats";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { matches, buildSnippet } from "./util";

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const q = query;
  const token = await getValidToken(ctx.userId);
  if (!token) return [];
  const listed = await listChatsResult(token.accessToken, 30, ctx.userId);
  if (!listed.ok) return [];
  const out: SearchResult[] = [];
  for (const chat of listed.chats) {
    const previewBody = chat.lastMessagePreview?.bodyText ?? "";
    const topic =
      chat.topic ||
      chat.members
        .map((m) => m.displayName || m.email)
        .slice(0, 3)
        .join(", ");
    if (matches(topic, q) || matches(previewBody, q)) {
      out.push({
        type: "chat",
        id: chat.id,
        title: topic || "(untitled chat)",
        snippet: buildSnippet(previewBody, q),
        timestamp:
          chat.lastUpdatedDateTime ||
          chat.lastMessagePreview?.createdDateTime ||
          "",
        url: `/messages?chat=${encodeURIComponent(chat.id)}`,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  if (q && out.length < perTypeLimit) {
    const seen = new Set(out.map((r) => r.id));
    for (const chat of listed.chats.slice(0, 5)) {
      if (seen.has(chat.id)) continue;
      const msgs = await getChatMessagesResult(
        token.accessToken,
        chat.id,
        20,
        ctx.userId,
      );
      if (!msgs.ok) continue;
      const hit = msgs.messages.find((m) => matches(m.bodyText, q));
      if (hit) {
        const topic =
          chat.topic ||
          chat.members
            .map((m) => m.displayName || m.email)
            .slice(0, 3)
            .join(", ");
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

export const chatsProvider: SearchProvider = {
  type: "chat",
  name: "Microsoft Teams chats",
  countKey: "chats",
  isEnabled: () => true,
  search,
};
