/**
 * Channels provider — searches the user's Microsoft Teams channels.
 * Stage 1 matches channel name/description across top teams; stage 2,
 * with a query and remaining slots, scans recent messages in channels
 * we haven't matched yet. Bounded — top 8 teams, top 20 channels
 * each, recent 20 messages per channel — to keep Graph traffic in
 * check; heavy queries are the eventual index's job.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import {
  listJoinedTeams,
  listTeamChannels,
  listChannelMessages,
} from "@/lib/ms-graph-teams";
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
  const teamsRes = await listJoinedTeams(token.accessToken, 10, ctx.userId);
  if (!teamsRes.ok) return [];
  const out: SearchResult[] = [];
  const channelTriples: Array<{
    teamId: string;
    teamName: string;
    channel: {
      id: string;
      displayName: string;
      description?: string;
      webUrl?: string;
    };
  }> = [];
  for (const team of teamsRes.teams.slice(0, 8)) {
    const chRes = await listTeamChannels(
      token.accessToken,
      team.id,
      20,
      ctx.userId,
    );
    if (!chRes.ok) continue;
    for (const ch of chRes.channels) {
      channelTriples.push({
        teamId: team.id,
        teamName: team.displayName,
        channel: ch,
      });
      if (
        matches(ch.displayName, q) ||
        matches(ch.description || "", q) ||
        matches(team.displayName, q)
      ) {
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
  if (q && out.length < perTypeLimit) {
    const seen = new Set(out.map((r) => r.id));
    for (const t of channelTriples) {
      const composite = `${t.teamId}:${t.channel.id}`;
      if (seen.has(composite)) continue;
      const msgs = await listChannelMessages(
        token.accessToken,
        t.teamId,
        t.channel.id,
        20,
        ctx.userId,
      );
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

export const channelsProvider: SearchProvider = {
  type: "channel",
  name: "Microsoft Teams channels",
  countKey: "channels",
  isEnabled: () => true,
  search,
};
